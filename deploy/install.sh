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
