#!/usr/bin/env bash
#
# Install Man Power as a systemd service.
#
#   sudo deploy/install.sh
#
# Idempotent: safe to re-run after editing the unit file.

set -euo pipefail

UNIT=man-power.service
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UNIT"
DEST="/etc/systemd/system/$UNIT"

if [[ $EUID -ne 0 ]]; then
  echo "This needs root to write $DEST — try: sudo $0" >&2
  exit 1
fi

install -m 0644 "$SRC" "$DEST"
systemctl daemon-reload
systemctl enable --now "$UNIT"

# Wait for it to actually answer, rather than trusting that it started.
PORT="$(grep -oP 'PORT=\K\d+' "$SRC" || echo 4321)"
for _ in $(seq 30); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    echo "Man Power is up on http://localhost:$PORT"
    systemctl --no-pager --lines=0 status "$UNIT"
    exit 0
  fi
  sleep 0.5
done

echo "Service did not answer on port $PORT. Recent log:" >&2
journalctl -u "$UNIT" --no-pager --lines=30 >&2
exit 1
