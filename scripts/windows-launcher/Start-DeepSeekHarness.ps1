[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'

function Get-EdgePath {
  $registryPaths = @(
    'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
    'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
    'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
  )

  foreach ($registryPath in $registryPaths) {
    if (Test-Path -LiteralPath $registryPath) {
      $candidate = (Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue).'(default)'
      if ($candidate -and (Test-Path -LiteralPath $candidate)) {
        return $candidate
      }
    }
  }

  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $candidates = @(
    (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )

  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Test-HarnessReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200 -and $response.Content -match 'DeepSeek|dsh-|<div id="root"'
  }
  catch {
    return $false
  }
}

function Show-LaunchError([string]$Message) {
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      $Message,
      'DeepSeek Harness launch failed',
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
  }
  catch {
  }
}

try {
  $appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $currentPath = Join-Path $appRoot 'app\current.json'
  $current = Get-Content -LiteralPath $currentPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $releasePath = [IO.Path]::GetFullPath([string]$current.releasePath)
  $releasesRoot = [IO.Path]::GetFullPath((Join-Path $appRoot 'app\releases'))

  if (-not $releasePath.StartsWith($releasesRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "current.json points outside the managed releases directory: $releasePath"
  }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $dshBin = Join-Path $releasePath 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (-not (Test-Path -LiteralPath $dshBin)) {
    throw "DSH entry point not found: $dshBin"
  }

  $hostName = '127.0.0.1'
  $port = 3080
  $url = "http://$hostName`:$port"
  $stateRoot = Join-Path $appRoot 'state'
  $logsRoot = Join-Path $appRoot 'logs'
  $statePath = Join-Path $stateRoot 'server.json'
  New-Item -ItemType Directory -Path $stateRoot, $logsRoot -Force | Out-Null

  if (-not (Test-HarnessReady $url)) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      throw "Port $port is owned by process $($listener.OwningProcess), but it is not a recognizable DeepSeek Harness server."
    }

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logsRoot "server-$timestamp.stdout.log"
    $stderrLog = Join-Path $logsRoot "server-$timestamp.stderr.log"
    $environmentSnapshot = @{
      DSH_HOME = $env:DSH_HOME
      DSH_AGENTS_HOME = $env:DSH_AGENTS_HOME
      DSH_TELEMETRY_DISABLED = $env:DSH_TELEMETRY_DISABLED
      NO_COLOR = $env:NO_COLOR
    }

    try {
      $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
      $env:DSH_AGENTS_HOME = Join-Path $env:USERPROFILE '.codex'
      $env:DSH_TELEMETRY_DISABLED = '1'
      $env:NO_COLOR = '1'
      $process = Start-Process -FilePath $node -ArgumentList @(
        $dshBin,
        '--profile', 'web',
        '--host', $hostName,
        '--port', [string]$port
      ) -WorkingDirectory $releasePath -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    }
    finally {
      foreach ($entry in $environmentSnapshot.GetEnumerator()) {
        if ($null -eq $entry.Value) {
          Remove-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        }
        else {
          Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
        }
      }
    }

    [ordered]@{
      pid = $process.Id
      version = [string]$current.version
      releasePath = $releasePath
      url = $url
      launchedAt = (Get-Date).ToString('o')
      stdoutLog = $stdoutLog
      stderrLog = $stderrLog
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

    $ready = $false
    for ($attempt = 0; $attempt -lt 360; $attempt++) {
      if ($process.HasExited) {
        $stderrTail = if (Test-Path -LiteralPath $stderrLog) {
          (Get-Content -LiteralPath $stderrLog -Tail 20 -Encoding UTF8) -join [Environment]::NewLine
        }
        else {
          ''
        }
        throw "DSH server exited early with code $($process.ExitCode).`n$stderrTail"
      }

      if (Test-HarnessReady $url) {
        $ready = $true
        break
      }

      Start-Sleep -Milliseconds 500
      $process.Refresh()
    }

    if (-not $ready) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw 'DSH server did not become ready within 180 seconds. The newly created process was stopped.'
    }
  }

  if (-not $NoBrowser) {
    $edge = Get-EdgePath
    if (-not $edge) {
      throw 'Microsoft Edge was not found, so App mode cannot be opened.'
    }

    Start-Process -FilePath $edge -ArgumentList @("--app=$url", '--start-maximized') | Out-Null
  }
}
catch {
  $appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $logsRoot = Join-Path $appRoot 'logs'
  New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
  $message = $_.Exception.Message
  "[$((Get-Date).ToString('o'))] $message" | Add-Content -LiteralPath (Join-Path $logsRoot 'launcher-errors.log') -Encoding UTF8
  if (-not $Silent) {
    Show-LaunchError $message
  }
  exit 1
}
