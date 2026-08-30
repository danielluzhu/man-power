#!/usr/bin/env bash
#
# Restore the Man Power database from its Litestream replica.
#
#   deploy/restore.sh              # restore to a temp file and verify it
#   sudo deploy/restore.sh --live  # stop the app, replace the database, start it
#
# The default is deliberately harmless: it proves the backup is restorable
# without touching anything. Run it now and then — an untested backup is a
# guess, and this one is holding messages that are weeks from arriving.

set -euo pipefail

CONFIG=${LITESTREAM_CONFIG:-/etc/litestream.yml}
DB=${MAN_POWER_DB:-/workspace/data/manpower.sqlite}
LIVE=no
[[ ${1:-} == --live ]] && LIVE=yes

command -v litestream >/dev/null || { echo "litestream is not installed" >&2; exit 1; }
[[ -r $CONFIG ]] || { echo "cannot read $CONFIG" >&2; exit 1; }

TARGET=$(mktemp -u /tmp/man-power-restore-XXXXXX.sqlite)
echo "Restoring from replica…"
litestream restore -config "$CONFIG" -o "$TARGET" "$DB"

# A file that exists is not a database that works. Check it opens, passes an
# integrity check, and actually holds the tables the app needs.
echo "Verifying…"
report=$(sqlite3 "$TARGET" "
  PRAGMA integrity_check;
  SELECT 'users='       || (SELECT COUNT(*) FROM users);
  SELECT 'messages='    || (SELECT COUNT(*) FROM messages);
  SELECT 'in_flight='   || (SELECT COUNT(*) FROM messages WHERE arrives_at > strftime('%s','now') * 1000);
")
echo "$report" | sed 's/^/  /'

grep -q '^ok$' <<<"$report" || { echo "Integrity check FAILED — not usable." >&2; exit 1; }

if [[ $LIVE == no ]]; then
  echo
  echo "Backup is good. Restored copy left at $TARGET"
  echo "Re-run with --live (as root) to put it in place of the live database."
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo "--live needs root" >&2; exit 1; }

echo
echo "Stopping the app…"
systemctl stop man-power.service

# Keep whatever is currently there. If the restore turns out to be the wrong
# point in time, the only other copy is the one about to be overwritten.
if [[ -f $DB ]]; then
  aside="$DB.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$DB" "$aside"
  rm -f "$DB-wal" "$DB-shm"
  echo "Previous database kept at $aside"
fi

install -o ubuntu -g ubuntu -m 0644 "$TARGET" "$DB"
rm -f "$TARGET"

# Litestream tracks position against the old file, so clear its local state.
systemctl stop litestream.service 2>/dev/null || true
litestream reset -config "$CONFIG" "$DB" 2>/dev/null || true
systemctl start litestream.service 2>/dev/null || true

systemctl start man-power.service
echo "Restored, and the app is back up."
