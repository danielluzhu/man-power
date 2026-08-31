#!/usr/bin/env bash
#
# Install Man Power and its continuous backup as systemd services.
#
#   sudo deploy/install.sh
#
# Idempotent: safe to re-run after editing any unit file.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR=/var/backups/man-power

if [[ $EUID -ne 0 ]]; then
  echo "This needs root to write to /etc/systemd/system — try: sudo $0" >&2
  exit 1
fi

# ── the app ──────────────────────────────────────────────────────────────────
install -m 0644 "$HERE/man-power.service" /etc/systemd/system/man-power.service

# Somewhere for credentials to live, outside the repository. Created empty so
# the path exists and the permissions are right before anything is put in it.
# Group-readable by the service account, so it can be inspected without sudo.
install -d -o root -g ubuntu -m 0750 /etc/man-power
[[ -f /etc/man-power/sms.env ]] || {
  install -o root -g ubuntu -m 0640 /dev/null /etc/man-power/sms.env
  cat > /etc/man-power/sms.env <<'ENVEOF'
# SMS provider credentials. Uncomment one set and restart:
#   sudo systemctl restart man-power
#
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_FROM=
#
# VONAGE_API_KEY=
# VONAGE_API_SECRET=
# VONAGE_FROM=
#
# Where the app answers from, so WebOTP can autofill the code:
# PUBLIC_ORIGIN=https://man-4321.another.ac
ENVEOF
  chmod 0640 /etc/man-power/sms.env
  chown root:ubuntu /etc/man-power/sms.env
}

# ── continuous backup ────────────────────────────────────────────────────────
if command -v litestream >/dev/null 2>&1; then
  install -d -o ubuntu -g ubuntu -m 0750 "$BACKUP_DIR" "$BACKUP_DIR/local"
  install -m 0644 "$HERE/litestream.yml" /etc/litestream.yml
  install -m 0644 "$HERE/litestream.service" /etc/systemd/system/litestream.service
  BACKUP=yes
else
  echo "litestream not found — skipping backups." >&2
  echo "  Install it from https://litestream.io/install/ and re-run this script." >&2
  BACKUP=no
fi

systemctl daemon-reload
systemctl enable --now man-power.service
[[ $BACKUP == yes ]] && systemctl enable --now litestream.service

# Wait for the app to actually answer, rather than trusting that it started.
PORT="$(grep -oP 'PORT=\K\d+' "$HERE/man-power.service" || echo 4321)"
for _ in $(seq 30); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    echo "Man Power is up on http://localhost:$PORT"

    # The clock is the product; say whether it is trusted.
    curl -fsS "http://localhost:$PORT/api/health" 2>/dev/null \
      | grep -oP '"driftSeconds":\s*\K[-0-9.]+' \
      | xargs -r -I{} echo "Clock drift: {}s"

    # Say plainly whether codes are being sent or merely logged.
    curl -fsS "http://localhost:$PORT/api/health" 2>/dev/null \
      | grep -q '"live":true' \
      && echo "SMS: sending for real" \
      || echo "SMS: NO PROVIDER — codes go to the journal, not to phones." \
              "Put credentials in /etc/man-power/sms.env (see deploy/install.sh)."

    if [[ $BACKUP == yes ]]; then
      echo "Backups replicating to $BACKUP_DIR/local"
      grep -q '^\s*- type: s3' /etc/litestream.yml \
        || echo "  NOTE: local replica only — it will not survive losing this machine." \
                "See deploy/litestream.yml to add an off-machine replica."
    fi
    exit 0
  fi
  sleep 0.5
done

echo "Service did not answer on port $PORT. Recent log:" >&2
journalctl -u man-power.service --no-pager --lines=30 >&2
exit 1
