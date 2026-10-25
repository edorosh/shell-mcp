# Copilot preToolUse hook: deny the built-in shell so commands go through shell-mcp.
# A non-zero exit denies the call (command preToolUse hooks fail closed); input we
# cannot parse is let through so a bug here cannot block the sandbox tools.
$raw = [Console]::In.ReadToEnd()
try {
  $j = $raw | ConvertFrom-Json
  $name = if ($j.toolName) { $j.toolName } else { $j.tool_name }
} catch { exit 0 }
if ($name -match '^(bash|powershell|shell|Bash|runInTerminal)$') {
  [Console]::Error.WriteLine("Built-in shell is disabled here. Use the sandbox shell tool (shell-mcp).")
  exit 2
}
exit 0
