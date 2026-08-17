[CmdletBinding(DefaultParameterSetName = 'Activate')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Activate')]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$CandidateName,

  [Parameter(Mandatory = $true, ParameterSetName = 'Rollback')]
  [string]$RollbackBackupPath,

  [Parameter(ParameterSetName = 'Activate')]
  [switch]$PreflightOnly,

  [string]$ProductionRoot = (Join-Path $env:LOCALAPPDATA 'DeepSeekHarness')
)

$ErrorActionPreference = 'Stop'

function Get-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path)
}

function Assert-Descendant([string]$Parent, [string]$Child, [string]$Label) {
  $parentFull = Get-FullPath $Parent
  $childFull = Get-FullPath $Child
  $prefix = $parentFull.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay under ${parentFull}: $childFull"
  }
}

function Write-Utf8JsonAtomically([string]$Path, [object]$Value) {
  $temporaryPath = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  $json = ($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine
  [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
  try {
    if (Test-Path -LiteralPath $Path) {
      if (-not ('DshReleaseNativeFile' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshReleaseNativeFile
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
}
'@
      }
      $replaceExistingAndWriteThrough = 0x1 -bor 0x8
      if (-not [DshReleaseNativeFile]::MoveFileEx($temporaryPath, $Path, $replaceExistingAndWriteThrough)) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [ComponentModel.Win32Exception]::new($errorCode)
      }
    }
    else {
      [IO.File]::Move($temporaryPath, $Path)
    }
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
}

function Stop-ManagedServer([string]$Root) {
  $stopScript = Join-Path $Root 'launcher\Stop-DeepSeekHarness.ps1'
  if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) {
    throw "Stop script not found: $stopScript"
  }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
  if ($LASTEXITCODE -ne 0) {
    throw "Stopping the managed DSH server failed with exit code $LASTEXITCODE"
  }

  $listener = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    throw "Port 3080 is still owned by process $($listener.OwningProcess); release switch refused"
  }
}

function Assert-SharedMcpWebProfile([string]$DshHome) {
  $profilePatchPath = Get-FullPath (Join-Path $DshHome 'profiles\web\cordis.patch.yml')
  if (-not (Test-Path -LiteralPath $profilePatchPath -PathType Leaf)) {
    throw "Web profile patch not found: $profilePatchPath"
  }

  $source = Get-Content -LiteralPath $profilePatchPath -Raw -Encoding UTF8
  $expected = @(
    [ordered]@{ id = 'mcp-sandbox'; serverName = 'sandbox'; url = 'http://127.0.0.1:14588/sandbox/mcp' },
    [ordered]@{ id = 'mcp-memory-store'; serverName = 'memory-store'; url = 'http://127.0.0.1:14588/memory-store/mcp' },
    [ordered]@{ id = 'mcp-web-fetcher'; serverName = 'web-fetcher'; url = 'http://127.0.0.1:14588/web-fetcher/mcp' },
    [ordered]@{ id = 'mcp-exa'; serverName = 'exa'; url = 'http://127.0.0.1:14588/exa/mcp' },
    [ordered]@{ id = 'mcp-sequential-thinking'; serverName = 'sequential-thinking'; url = 'http://127.0.0.1:14588/sequential-thinking/mcp' }
  )

  foreach ($entry in $expected) {
    $idCount = [Regex]::Matches($source, "(?m)^\s*- id:\s*$([Regex]::Escape($entry.id))\s*$").Count
    $serverCount = [Regex]::Matches($source, "(?m)^\s*serverName:\s*$([Regex]::Escape($entry.serverName))\s*$").Count
    $urlCount = [Regex]::Matches($source, "(?m)^\s*url:\s*$([Regex]::Escape($entry.url))\s*$").Count
    if ($idCount -ne 1 -or $serverCount -ne 1 -or $urlCount -ne 1) {
      throw "Web profile shared MCP entry must appear exactly once: $($entry.id)"
    }
  }

  return [ordered]@{
    path = $profilePatchPath
    sha256 = (Get-FileHash -LiteralPath $profilePatchPath -Algorithm SHA256).Hash
    serverNames = @($expected | ForEach-Object { $_.serverName })
  }
}

$workspaceRoot = Get-FullPath (Join-Path $PSScriptRoot '..')
$productionRootFull = Get-FullPath $ProductionRoot
$releasesRoot = Get-FullPath (Join-Path $productionRootFull 'app\releases')
$backupsRoot = Get-FullPath (Join-Path $productionRootFull 'backups')
$currentPath = Get-FullPath (Join-Path $productionRootFull 'app\current.json')

Assert-Descendant $productionRootFull $releasesRoot 'release root'
Assert-Descendant $productionRootFull $backupsRoot 'backup root'
Assert-Descendant $productionRootFull $currentPath 'current pointer'
New-Item -ItemType Directory -Path $releasesRoot, $backupsRoot -Force | Out-Null

if ($PSCmdlet.ParameterSetName -eq 'Rollback') {
  $backupRootFull = Get-FullPath $RollbackBackupPath
  Assert-Descendant $backupsRoot $backupRootFull 'rollback backup directory'
  $backupCurrentPath = Join-Path $backupRootFull 'current.json'
  if (-not (Test-Path -LiteralPath $backupCurrentPath -PathType Leaf)) {
    throw "Backup pointer not found: $backupCurrentPath"
  }

  $backupCurrent = Get-Content -LiteralPath $backupCurrentPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $backupReleasePath = Get-FullPath ([string]$backupCurrent.releasePath)
  Assert-Descendant $releasesRoot $backupReleasePath 'rollback release'
  if (-not (Test-Path -LiteralPath $backupReleasePath -PathType Container)) {
    throw "Rollback release not found: $backupReleasePath"
  }

  Stop-ManagedServer $productionRootFull
  Write-Utf8JsonAtomically $currentPath ([ordered]@{
    version = [string]$backupCurrent.version
    releasePath = $backupReleasePath
  })

  [ordered]@{
    ok = $true
    action = 'rollback'
    restoredFrom = $backupRootFull
    version = [string]$backupCurrent.version
    releasePath = $backupReleasePath
  } | ConvertTo-Json -Depth 4
  exit 0
}

$candidatesRoot = Get-FullPath (Join-Path $workspaceRoot 'release\candidates')
$candidatePath = Get-FullPath (Join-Path $candidatesRoot $CandidateName)
if ((Split-Path -Parent $candidatePath) -ne $candidatesRoot) {
  throw "Candidate must be a direct child of $candidatesRoot"
}
if (-not (Test-Path -LiteralPath $candidatePath -PathType Container)) {
  throw "Candidate directory not found: $candidatePath"
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$verifyScript = Join-Path $workspaceRoot 'scripts\Verify-CandidateRelease.mjs'
$verifyOutput = (& $node --no-warnings $verifyScript --candidate $CandidateName 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Candidate verification failed: $verifyOutput"
}

$candidateManifestPath = Join-Path $candidatePath 'stardust\candidate-manifest.json'
$candidateManifestHash = (Get-FileHash -LiteralPath $candidateManifestPath -Algorithm SHA256).Hash
$candidateManifest = Get-Content -LiteralPath $candidateManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$candidateManifest.candidateName -ne $CandidateName -or $candidateManifest.productionActivated -ne $false) {
  throw 'Candidate manifest identity or activation state is invalid'
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$sharedMcpProfile = Assert-SharedMcpWebProfile $dshHome

if (-not (Test-Path -LiteralPath $currentPath -PathType Leaf)) {
  throw "Current pointer not found: $currentPath"
}
$currentBefore = Get-Content -LiteralPath $currentPath -Raw -Encoding UTF8 | ConvertFrom-Json
$currentReleaseBefore = Get-FullPath ([string]$currentBefore.releasePath)
Assert-Descendant $releasesRoot $currentReleaseBefore 'current release'

if ($PreflightOnly) {
  [ordered]@{
    ok = $true
    action = 'preflight'
    candidateName = $CandidateName
    candidateManifestSha256 = $candidateManifestHash
    sharedMcpProfile = $sharedMcpProfile
    current = [ordered]@{
      version = [string]$currentBefore.version
      releasePath = $currentReleaseBefore
    }
    verifier = $verifyOutput
  } | ConvertTo-Json -Depth 6
  exit 0
}

Stop-ManagedServer $productionRootFull

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Get-FullPath (Join-Path $backupsRoot "production-switch-$timestamp-$([Guid]::NewGuid().ToString('N').Substring(0, 8))")
Assert-Descendant $backupsRoot $backupPath 'switch backup directory'
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
Copy-Item -LiteralPath $currentPath -Destination (Join-Path $backupPath 'current.json')
Copy-Item -LiteralPath $candidateManifestPath -Destination (Join-Path $backupPath 'candidate-manifest.json')

$targetReleasePath = Get-FullPath (Join-Path $releasesRoot $CandidateName)
if ((Split-Path -Parent $targetReleasePath) -ne $releasesRoot) {
  throw 'Target release must be a direct child of the managed releases directory'
}

$installedNow = $false
if (Test-Path -LiteralPath $targetReleasePath) {
  $targetManifestPath = Join-Path $targetReleasePath 'stardust\candidate-manifest.json'
  if (-not (Test-Path -LiteralPath $targetManifestPath -PathType Leaf)) {
    throw "Target release exists without a candidate manifest: $targetReleasePath"
  }
  $targetManifestHash = (Get-FileHash -LiteralPath $targetManifestPath -Algorithm SHA256).Hash
  if ($targetManifestHash -ne $candidateManifestHash) {
    throw "Target release exists but differs from the candidate: $targetReleasePath"
  }
}
else {
  $stagingPath = Get-FullPath (Join-Path $releasesRoot "$CandidateName.staging-$([Guid]::NewGuid().ToString('N').Substring(0, 8))")
  Assert-Descendant $releasesRoot $stagingPath 'installation staging directory'
  try {
    Copy-Item -LiteralPath $candidatePath -Destination $stagingPath -Recurse
    $stagingManifestPath = Join-Path $stagingPath 'stardust\candidate-manifest.json'
    $stagingManifestHash = (Get-FileHash -LiteralPath $stagingManifestPath -Algorithm SHA256).Hash
    if ($stagingManifestHash -ne $candidateManifestHash) {
      throw 'Copied candidate manifest hash mismatch'
    }
    Move-Item -LiteralPath $stagingPath -Destination $targetReleasePath
    $installedNow = $true
  }
  finally {
    if (Test-Path -LiteralPath $stagingPath) {
      Remove-Item -LiteralPath $stagingPath -Recurse -Force
    }
  }
}

$nextCurrent = [ordered]@{
  version = $CandidateName
  releasePath = $targetReleasePath
}
Write-Utf8JsonAtomically $currentPath $nextCurrent

$metadata = [ordered]@{
  schemaVersion = 1
  switchedAt = (Get-Date).ToString('o')
  candidateName = $CandidateName
  candidateManifestSha256 = $candidateManifestHash
  sharedMcpProfile = $sharedMcpProfile
  installedNow = $installedNow
  previous = [ordered]@{
    version = [string]$currentBefore.version
    releasePath = $currentReleaseBefore
  }
  current = $nextCurrent
  rollbackCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RollbackBackupPath `"$backupPath`""
}
Write-Utf8JsonAtomically (Join-Path $backupPath 'switch-metadata.json') $metadata

[ordered]@{
  ok = $true
  action = 'activate'
  version = $CandidateName
  releasePath = $targetReleasePath
  backupPath = $backupPath
  candidateManifestSha256 = $candidateManifestHash
  sharedMcpProfile = $sharedMcpProfile
  installedNow = $installedNow
  verifier = $verifyOutput
} | ConvertTo-Json -Depth 6
