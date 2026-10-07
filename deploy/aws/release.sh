#!/usr/bin/env bash
# Package the current commit, upload to the private bucket and roll it out on the instance through SSM.
set -euo pipefail
cd "$(dirname "$0")"; ROOT="$(cd ../.. && pwd)"
export AWS_REGION="${AWS_REGION:-ap-south-1}" AWS_PAGER=""
st() { python3 -c "import json;print(json.load(open('.state.json')).get('$1',''))"; }
BUCKET=$(st bucket); INSTANCE=$(st instance); REL="r$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD)"
TGZ="/tmp/$REL.tgz"
( cd "$ROOT" && git archive --format=tar HEAD | gzip > "$TGZ" )
aws s3 cp "$TGZ" "s3://$BUCKET/releases/$REL.tgz" --only-show-errors
aws ssm wait instance-information-exists --filters Key=InstanceIds,Values=$INSTANCE 2>/dev/null || true
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 1800 \
  --parameters "commands=[\"until [ -x /opt/crmbee/apply.sh ]; do sleep 5; done\",\"/opt/crmbee/apply.sh releases/$REL.tgz $BUCKET $AWS_REGION 2>&1 | tail -60\"]" --query Command.CommandId --output text)
echo "release $REL rolling out (SSM command $CMD)"
while true; do
  S=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case $S in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 10; done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -40
[ "$S" = Success ]
