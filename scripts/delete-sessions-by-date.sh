#!/usr/bin/env bash
# Delete sessions from a specific date for a project.
#
# Usage:
#   ./scripts/delete-sessions-by-date.sh <project-id> <YYYY-MM-DD> [--dry-run]
#
# Example:
#   ./scripts/delete-sessions-by-date.sh session-analyzer 2026-09-09 --dry-run
#   ./scripts/delete-sessions-by-date.sh session-analyzer 2026-09-09
#
# Requires devin-sync to be on PATH with SAL_STORAGE_* and SAL_PROJECT_ID
# environment variables set (same env you'd use for `devin-sync list`).
#
# Safety:
#   --dry-run  Lists what would be deleted without deleting anything.
#   Without --dry-run, prompts for confirmation before deleting.

set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <project-id> <YYYY-MM-DD> [--dry-run]}"
TARGET_DATE="${2:?Usage: $0 <project-id> <YYYY-MM-DD> [--dry-run]}"
DRY_RUN="${3:-}"

if [ "$PROJECT_ID" = "--dry-run" ] || [ "$PROJECT_ID" = "-h" ] || [ "$PROJECT_ID" = "--help" ]; then
  echo "Usage: $0 <project-id> <YYYY-MM-DD> [--dry-run]"
  exit 0
fi

echo "Listing sessions for project: $PROJECT_ID"
echo "Filtering by date: $TARGET_DATE"
echo ""

# Parse `devin-sync list <project-id>` output. The table looks like:
#   SESSION ID                            FILES  SIZE        LAST MODIFIED
#   -------------------------------------------------------------------------
#   sparkling-hornet                      4      1.9 MB      2026-09-09 13:44
#   a7a638ef-2243-430f-b020-19559a2aeef2  1      3.7 KB      2026-09-04 10:40
#
# We extract column 1 (session ID) and the date portion of the LAST MODIFIED
# column, then filter rows where the date matches TARGET_DATE.

SESSION_IDS=$(devin-sync list "$PROJECT_ID" 2>/dev/null | awk '
  # Skip header rows
  /^SESSION ID/ { next }
  /^---/ { next }
  /^$/ { next }
  /^Found / { next }
  /^[0-9]+ session\(s\)/ { next }
  {
    session_id = $1
    # LAST MODIFIED is the second-to-last field (date), followed by time
    # Find the date pattern YYYY-MM-DD in the line
    for (i = NF; i >= 1; i--) {
      if ($i ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) {
        date = $i
        break
      }
    }
    if (date == "'"$TARGET_DATE"'") {
      print session_id
    }
  }
')

COUNT=$(echo "$SESSION_IDS" | grep -c . || true)

if [ "$COUNT" -eq 0 ]; then
  echo "No sessions found matching date $TARGET_DATE for project $PROJECT_ID."
  exit 0
fi

echo "Found $COUNT session(s) from $TARGET_DATE:"
echo ""
echo "$SESSION_IDS" | head -20
if [ "$COUNT" -gt 20 ]; then
  echo "... and $((COUNT - 20)) more"
fi
echo ""

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "[dry-run] No sessions were deleted."
  exit 0
fi

echo "WARNING: This will permanently delete $COUNT session(s) from $TARGET_DATE."
echo "This action cannot be undone."
echo ""
read -rp "Type 'yes' to confirm deletion: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo ""
DELETED=0
FAILED=0
while IFS= read -r SID; do
  [ -z "$SID" ] && continue
  echo -n "Removing $SID ... "
  if devin-sync remove "$PROJECT_ID" --session="$SID" --yes 2>/dev/null; then
    echo "OK"
    DELETED=$((DELETED + 1))
  else
    echo "FAILED"
    FAILED=$((FAILED + 1))
  fi
done <<< "$SESSION_IDS"

echo ""
echo "Done. Deleted: $DELETED, Failed: $FAILED"
