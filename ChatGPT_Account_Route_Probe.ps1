param([string]$Cdp = 'http://127.0.0.1:9222', [int]$Port = 0)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 22+ is required.' }
& $nodeCommand.Source (Join-Path $PSScriptRoot 'ChatGPT_Account_Route_Probe.mjs') --cdp $Cdp --port $Port
exit $LASTEXITCODE
