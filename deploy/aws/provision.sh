#!/usr/bin/env bash
# Creates the AWS resources for the one-host deployment (idempotent; state in .state.json, gitignored).
#   AWS_REGION=ap-south-1 ./provision.sh        # then ./release.sh
set -euo pipefail
cd "$(dirname "$0")"; ROOT="$(cd ../.. && pwd)"
export AWS_REGION="${AWS_REGION:-ap-south-1}" AWS_PAGER=""
NAME=crmbee; ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="$NAME-releases-$ACCOUNT-$AWS_REGION"; SECRET="$NAME/env"; ROLE="$NAME-ec2"; SG_NAME="$NAME-web"
state() { python3 - "$@" <<'P'
import json,sys,os
f='.state.json'; d=json.load(open(f)) if os.path.exists(f) else {}
if len(sys.argv)==3: d[sys.argv[1]]=sys.argv[2]; json.dump(d,open(f,'w'),indent=1)
else: print(d.get(sys.argv[1],''))
P
}

# 1. Elastic IP (stable address -> stable HTTPS names)
EIP_ALLOC=$(state eip_alloc); if [ -z "$EIP_ALLOC" ]; then
  read -r EIP_ALLOC IP < <(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query '[AllocationId,PublicIp]' --output text)
  state eip_alloc "$EIP_ALLOC"; state ip "$IP"; fi
IP=$(state ip); DASH=${IP//./-}; state crm_host "crm.$DASH.sslip.io"; state bee_host "bee.$DASH.sslip.io"
echo "Elastic IP $IP  CRM https://crm.$DASH.sslip.io  Bee https://bee.$DASH.sslip.io"

# 2. Secrets (generated once; the Supabase + OpenAI values come from .env.local)
if ! aws secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
python3 - "$ROOT/.env.local" "$(state crm_host)" "$(state bee_host)" "$SECRET" <<'P'
import sys,secrets,subprocess,json
env={}
for l in open(sys.argv[1]):
    l=l.strip()
    if l and not l.startswith('#') and '=' in l:
        k,v=l.split('=',1); env[k]=v.strip('"')
crm,bee,secret=sys.argv[2:5]
r=lambda n=24: secrets.token_hex(n)
tw_pg,tw_app,tw_enc=r(16),r(32),r(32)
agent_tok,chat_tok=r(24),r(24)
compose=f"""CRM_HOST={crm}
BEE_HOST={bee}
TWENTY_PG_PASSWORD={tw_pg}
TWENTY_APP_SECRET={tw_app}
TWENTY_ENCRYPTION_KEY={tw_enc}
OPENAI_API_KEY={env['OPENAI_API_KEY']}
"""
beeenv=f"""NODE_ENV=production
LOG_LEVEL=info
MIGRATION_DATABASE_URL={env['MIGRATION_DATABASE_URL']}
DATABASE_URL={env['DATABASE_URL']}
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=/data/media
S3_ENDPOINT=http://127.0.0.1:9
S3_ACCESS_KEY=unused
S3_SECRET_KEY=unused-unused
S3_BUCKET=unused
JWT_SECRET={r(32)}
ADMIN_API_KEY={r(24)}
TWENTY_API_URL=https://{crm}
TWENTY_API_RATE_LIMIT=80
REDIS_URL=redis://bee-redis:6379
QUEUE_PREFIX=crmbee
AGENT_URL=http://agent:8001
AGENT_TOKEN={agent_tok}
CRM_CHAT_TOKEN={chat_tok}
OPENAI_API_KEY={env['OPENAI_API_KEY']}
OPENAI_MODEL={env.get('OPENAI_MODEL','gpt-4o-mini')}
OPENAI_BASE_URL={env.get('OPENAI_BASE_URL','https://api.openai.com/v1')}
"""
agent=f"""OPENAI_API_KEY={env['OPENAI_API_KEY']}
OPENAI_MODEL={env.get('OPENAI_MODEL','gpt-4o-mini')}
OPENAI_BASE_URL={env.get('OPENAI_BASE_URL','https://api.openai.com/v1')}
AGENT_TOKEN={agent_tok}
"""
body=json.dumps({"compose.env":compose,"bee.env":beeenv,"agent.env":agent})
subprocess.run(["aws","secretsmanager","create-secret","--name",secret,"--secret-string",body,"--output","text","--query","ARN"],check=True,stdout=subprocess.DEVNULL)
P
echo "secret $SECRET created"; fi

# 3. Release bucket (private)
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || {
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'; }
state bucket "$BUCKET"

# 4. Instance role: SSM (no SSH), read releases, read/update the env secret
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"; fi
aws iam put-role-policy --role-name "$ROLE" --policy-name app --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
 {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},
 {\"Effect\":\"Allow\",\"Action\":[\"secretsmanager:GetSecretValue\",\"secretsmanager:PutSecretValue\"],\"Resource\":\"arn:aws:secretsmanager:$AWS_REGION:$ACCOUNT:secret:$SECRET-*\"}]}"

# 5. Security group: HTTP/HTTPS only
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name $SG_NAME --description "CRM Bee web" --vpc-id "$VPC" --query GroupId --output text)
  for p in 80 443; do aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port $p --cidr 0.0.0.0/0 >/dev/null; done; fi
state sg "$SG"

# 6. Instance
INSTANCE=$(state instance); if [ -z "$INSTANCE" ]; then
  sleep 10   # IAM propagation
  AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
  INSTANCE=$(aws ec2 run-instances --image-id "$AMI" --instance-type "${INSTANCE_TYPE:-t3.large}" --iam-instance-profile Name=$ROLE --security-group-ids "$SG" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=60,VolumeType=gp3,Encrypted=true}' --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --user-data file://userdata.sh --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)
  state instance "$INSTANCE"; aws ec2 wait instance-running --instance-ids "$INSTANCE"
  aws ec2 associate-address --instance-id "$INSTANCE" --allocation-id "$EIP_ALLOC" >/dev/null; fi
echo "instance $INSTANCE ready; next: ./release.sh"
