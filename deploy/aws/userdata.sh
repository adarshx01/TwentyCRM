#!/bin/bash
# First boot: Docker + the release helper. Secrets and code arrive later through release.sh (SSM), never through user-data.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y docker.io docker-compose-v2 jq unzip curl
command -v aws >/dev/null || { curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install; }
systemctl enable --now docker
mkdir -p /opt/crmbee/releases
cat > /opt/crmbee/apply.sh <<'EOS'
#!/bin/bash
# usage: apply.sh <s3-key> <bucket> <region>   (run by SSM as root)
set -euo pipefail
KEY=$1; BUCKET=$2; export AWS_DEFAULT_REGION=$3
cd /opt/crmbee
REL=$(basename "$KEY" .tgz)
aws s3 cp "s3://$BUCKET/$KEY" "/opt/crmbee/releases/$REL.tgz" --only-show-errors
rm -rf "/opt/crmbee/current.new"; mkdir "/opt/crmbee/current.new"; tar -xzf "/opt/crmbee/releases/$REL.tgz" -C /opt/crmbee/current.new
rm -rf /opt/crmbee/current; mv /opt/crmbee/current.new /opt/crmbee/current
S=$(aws secretsmanager get-secret-value --secret-id crmbee/env --query SecretString --output text)
umask 077
for f in compose.env bee.env agent.env; do echo "$S" | jq -r --arg f "$f" '.[$f]' > "/opt/crmbee/$f"; done
cd /opt/crmbee/current/deploy/aws
export RELEASE=$REL
docker compose --env-file /opt/crmbee/compose.env build
docker compose --env-file /opt/crmbee/compose.env run --rm --no-deps bee-api node dist/database/migrate.js
docker compose --env-file /opt/crmbee/compose.env up -d --remove-orphans
docker image prune -f >/dev/null
EOS
chmod +x /opt/crmbee/apply.sh
