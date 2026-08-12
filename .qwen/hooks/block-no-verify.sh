#!/bin/bash
# PreToolUse hook: blocks any tool call whose input contains "--no-verify",
# so pre-commit checks (e.g. husky) can never be bypassed.
#
# Input: hook JSON on stdin (tool_name, tool_input, ...)
# Output: deny decision JSON when the flag is present; no output otherwise
#         (empty output lets the normal permission flow proceed).

INPUT=$(cat)

if printf '%s' "$INPUT" | grep -qF -- '--no-verify'; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by project policy: '--no-verify' is not allowed. Pre-commit checks must not be bypassed."
  }
}
EOF
fi

exit 0
