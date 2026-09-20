#!/usr/bin/env bash
# Back up every Multiloger profile via the local API.
# Install: /opt/multiloger/backup-all.sh, chmod 700, owner multiloger.
# Requires: MULTILOGER_CRON_TOKEN in /etc/multiloger/multiloger.env
#   (a dedicated API token named e.g. "backup-cron").
set -euo pipefail

API="${MULTILOGER_API_URL:-http://127.0.0.1:3000}"
TOKEN="${MULTILOGER_CRON_TOKEN:?MULTILOGER_CRON_TOKEN must be set in the environment file}"

api() {
  curl -fsS -H "Authorization: Bearer ${TOKEN}" "$@"
}

echo "[backup-all] listing profiles"
profiles_json="$(api "${API}/v1/profiles")"
# Extract ids without jq (not guaranteed installed): node is always present here.
ids="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).profiles??[])console.log(p.id)})' <<<"${profiles_json}")"

fail=0
count=0
while IFS= read -r id; do
  [ -n "${id}" ] || continue
  echo "[backup-all] backing up profile ${id}"
  if api -X POST "${API}/v1/profiles/${id}/backups" -o /dev/null; then
    count=$((count + 1))
  else
    echo "[backup-all] FAILED for profile ${id}" >&2
    fail=1
  fi
done <<<"${ids}"

echo "[backup-all] done: ${count} profile(s) backed up"
# Non-zero exit → systemd marks the service failed → journalctl shows it.
exit "${fail}"
