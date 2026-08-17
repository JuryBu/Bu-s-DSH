[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statePath = Join-Path $appRoot 'state\server.json'

if (-not (Test-Path -LiteralPath $statePath)) {
  exit 0
}

$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction SilentlyContinue

if (-not $process) {
  Remove-Item -LiteralPath $statePath -Force
  exit 0
}

$expectedRelease = [IO.Path]::GetFullPath([string]$state.releasePath)
$commandLine = [string]$process.CommandLine
if ($commandLine.IndexOf($expectedRelease, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $commandLine.IndexOf('@deepseek-ai\dsh\lib\bin.js', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "PID $($state.pid) is no longer the DSH process created by this launcher. Stop was refused."
}

Stop-Process -Id ([int]$state.pid) -ErrorAction Stop
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if (-not (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue)) {
    break
  }
  Start-Sleep -Milliseconds 250
}

if (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue) {
  Stop-Process -Id ([int]$state.pid) -Force -ErrorAction Stop
}

Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
