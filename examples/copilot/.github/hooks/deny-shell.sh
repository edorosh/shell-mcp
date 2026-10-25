#!/usr/bin/env bash
# Copilot preToolUse hook: deny the built-in shell so commands go through shell-mcp.
# A non-zero exit denies the call (command preToolUse hooks fail closed); input we
# cannot parse is let through so a bug here cannot block the sandbox tools.
raw=$(cat) || exit 0
if command -v jq >/dev/null 2>&1; then
  name=$(printf '%s' "$raw" | jq -r '.toolName // .tool_name // empty' 2>/dev/null) || exit 0
else
  name=$(printf '%s' "$raw" | tr -d '\n' |
    sed -n -E 's/.*"(toolName|tool_name)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/p')
fi
case "$name" in
  bash|powershell|shell|Bash|runInTerminal)
    echo "Built-in shell is disabled here. Use the sandbox shell tool (shell-mcp)." >&2
    exit 2
    ;;
esac
exit 0
