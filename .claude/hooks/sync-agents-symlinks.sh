#!/bin/bash
# SessionStart hook: ensures .agents/<name> is a symlink to .claude/<name> for
# name in {rules, skills, agents}. .claude/<name> is the canonical content
# location Claude Code itself reads; .agents/<name> is a compatibility
# symlink so other tools/conventions that look under .agents/ (see
# .qwen/rules, .qwen/agents for a parallel multi-tool pattern in this repo)
# transparently see the same content.
#
# Runs on every session start, so it must be fast, non-interactive, and safe
# to re-run. For each pair:
#   - .agents/<name> is already a symlink resolving to .claude/<name>: no-op.
#   - .agents/<name> is missing entirely: .claude/<name> is created as an
#     empty directory if it doesn't already exist, then .agents/<name> is
#     symlinked to it. (Decision: create the canonical dir eagerly rather
#     than link to a not-yet-existing target, so the pair is immediately
#     usable and unambiguous.)
#   - .agents/<name> is a symlink pointing somewhere else (stale/wrong): the
#     stale symlink is removed and recreated pointing at .claude/<name>. This
#     is safe because only a symlink is ever touched here, never real content.
#   - .agents/<name> exists as a real file or directory with actual content
#     (not a symlink): left COMPLETELY untouched. A non-fatal warning is
#     printed to stderr explaining the conflict and how to resolve it by
#     hand. Session start is never blocked by this.
#
# Input: hook JSON on stdin (SessionStart payload) - read and discarded; none
#        of its fields (session_id, source, cwd, ...) affect this hook.
# Output: warnings on stderr when a conflict is found; otherwise silent.
# Exit code: always 0 - this hook must never block session start.

set -u

# Discard the stdin JSON payload so the script behaves the same whether or
# not Claude Code pipes one in.
cat >/dev/null

# Resolve the project root reliably regardless of the directory the hook is
# invoked from. Claude Code exports CLAUDE_PROJECT_DIR to hook commands; fall
# back to the script's own on-disk location (.claude/hooks/<this>.sh is
# always two directories below the project root) so the script also works
# when run/tested directly outside of a Claude Code session.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd)}"

if [ -z "$PROJECT_ROOT" ] || [ ! -d "$PROJECT_ROOT" ]; then
  echo "sync-agents-symlinks: could not determine project root; skipping." >&2
  exit 0
fi

# Canonicalize a path to its absolute, symlink-resolved form. Prefers
# realpath (present on modern macOS and Linux); falls back to a manual
# cd+pwd resolution of the parent directory so this still works in a
# minimal environment without realpath/readlink -f.
canonical_path() {
  local target="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$target" 2>/dev/null && return
  fi
  local dir base
  dir="$(dirname "$target")"
  base="$(basename "$target")"
  if [ -d "$dir" ]; then
    printf '%s/%s\n' "$(cd "$dir" >/dev/null 2>&1 && pwd -P)" "$base"
  else
    printf '%s\n' "$target"
  fi
}

sync_one() {
  local name="$1"
  local claude_dir="$PROJECT_ROOT/.claude/$name"
  local agents_link="$PROJECT_ROOT/.agents/$name"
  local rel_target="../.claude/$name"

  if [ -L "$agents_link" ]; then
    # Already a symlink - check whether it resolves to the right place.
    local current_resolved expected_resolved
    current_resolved="$(canonical_path "$agents_link")"
    expected_resolved="$(canonical_path "$claude_dir")"
    if [ -n "$current_resolved" ] && [ "$current_resolved" = "$expected_resolved" ]; then
      return 0
    fi
    # Stale/wrong target - safe to fix since it's only a symlink.
    rm -f "$agents_link"
    mkdir -p "$claude_dir"
    ln -s "$rel_target" "$agents_link"
    echo "sync-agents-symlinks: fixed stale symlink .agents/$name -> $rel_target" >&2
    return 0
  fi

  if [ -e "$agents_link" ]; then
    # Real file or directory with content - never delete or overwrite.
    echo "sync-agents-symlinks: WARNING: .agents/$name exists and is real content (not a symlink)." >&2
    echo "sync-agents-symlinks:   Leaving it untouched. To resolve: move/merge its contents into" >&2
    echo "sync-agents-symlinks:   .claude/$name, delete .agents/$name, then start a new session." >&2
    return 0
  fi

  # Missing entirely - ensure the canonical .claude/<name> exists, then link.
  mkdir -p "$claude_dir"
  ln -s "$rel_target" "$agents_link"
}

mkdir -p "$PROJECT_ROOT/.agents"

for name in rules skills agents; do
  sync_one "$name"
done

exit 0
