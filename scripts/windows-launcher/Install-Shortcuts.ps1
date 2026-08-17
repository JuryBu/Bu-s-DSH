[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopExe = Join-Path $appRoot 'desktop\current\DeepSeekHarnessDesktop.exe'
$startScript = Join-Path $PSScriptRoot 'Start-DeepSeekHarness.ps1'
$stopScript = Join-Path $PSScriptRoot 'Stop-DeepSeekHarness.ps1'
$icon = Join-Path $PSScriptRoot 'assets\deepseek-harness.ico'
$powershell = Join-Path $PSHOME 'powershell.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek Harness'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell

if (-not (Test-Path -LiteralPath $desktopExe)) {
  throw "Desktop executable not found: $desktopExe"
}

function Save-ExeShortcut([string]$Path, [string]$Description) {
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $desktopExe
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = Split-Path -Parent $desktopExe
  $shortcut.IconLocation = "$desktopExe,0"
  $shortcut.Description = $Description
  $shortcut.Save()
}

function Save-ScriptShortcut([string]$Path, [string]$Script, [string]$Description) {
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
  $shortcut.WorkingDirectory = $env:USERPROFILE
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = $Description
  $shortcut.Save()
}

Save-ExeShortcut (Join-Path $desktop 'DeepSeek Harness.lnk') 'Open DeepSeek Harness Desktop'
Save-ExeShortcut (Join-Path $startMenu 'DeepSeek Harness.lnk') 'Open DeepSeek Harness Desktop'
Save-ScriptShortcut (Join-Path $startMenu 'DeepSeek Harness (Browser fallback).lnk') $startScript 'Open DeepSeek Harness in Edge App mode'
Save-ScriptShortcut (Join-Path $startMenu 'Stop DeepSeek Harness.lnk') $stopScript 'Stop the local DeepSeek Harness service'
