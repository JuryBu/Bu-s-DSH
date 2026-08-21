param(
    [Parameter(Mandatory = $true)]
    [string]$PublishDir,

    [string]$RuntimeRoot = "$env:LOCALAPPDATA\DeepSeekHarness",

    [switch]$AllowStopDesktop,

    [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'

function Resolve-ExistingDirectory([string]$PathValue, [string]$Label) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        throw "$Label does not exist: $PathValue"
    }

    (Resolve-Path -LiteralPath $PathValue).Path
}

function Resolve-ExistingFile([string]$PathValue, [string]$Label) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
        throw "$Label does not exist: $PathValue"
    }

    (Resolve-Path -LiteralPath $PathValue).Path
}

function Assert-UnderRoot($PathValue, $RootValue, $Label) {
    if (-not $PathValue -and $args.Count -ge 1) {
        $PathValue = $args[0]
    }
    if (-not $RootValue -and $args.Count -ge 2) {
        $RootValue = $args[1]
    }
    if (-not $Label -and $args.Count -ge 3) {
        $Label = $args[2]
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath([string]$PathValue)
    }
    catch {
        throw "$Label path is invalid: [$PathValue]"
    }

    $fullRoot = [System.IO.Path]::GetFullPath([string]$RootValue)
    $fullRoot = $fullRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    if (-not ($fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
        throw "$Label is outside expected root: $fullPath"
    }
}

function Set-JsonProperty([object]$Target, [string]$Name, [object]$Value) {
    if ($Target.PSObject.Properties[$Name]) {
        $Target.$Name = $Value
    }
    else {
        $Target | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
}

$publishPath = Resolve-ExistingDirectory $PublishDir 'desktop shell publish directory'
$exePath = Resolve-ExistingFile (Join-Path $publishPath 'DeepSeekHarnessDesktop.exe') 'desktop shell exe'
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeRoot)
$desktopRoot = [System.IO.Path]::Combine($runtimePath, 'desktop')
$desktopCurrentDir = [System.IO.Path]::Combine($desktopRoot, 'current')
$backupsRoot = [System.IO.Path]::Combine($runtimePath, 'backups')
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = [System.IO.Path]::Combine($backupsRoot, "desktop-shell-switch-$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))")
$stagingPath = [System.IO.Path]::Combine($desktopRoot, "current.staging-$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))")
$manifestPath = [System.IO.Path]::Combine($runtimePath, 'install-manifest.json')
$newHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
$newBytes = (Get-Item -LiteralPath $exePath).Length

if ($env:DSH_DESKTOP_PUBLISH_DEBUG_PATHS -eq '1') {
    throw "debug paths: runtimePath=[$runtimePath] desktopRoot=[$desktopRoot] desktopCurrentDir=[$desktopCurrentDir] stagingPath=[$stagingPath] backupPath=[$backupPath]"
}

Assert-UnderRoot $desktopRoot $runtimePath 'desktop root'
Assert-UnderRoot $desktopCurrentDir $desktopRoot 'current directory'
Assert-UnderRoot $stagingPath $desktopRoot 'staging directory'
Assert-UnderRoot $backupPath $backupsRoot 'backup directory'

$currentPathFull = [System.IO.Path]::GetFullPath($desktopCurrentDir)
$currentPathFull = $currentPathFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$runningDesktop = Get-CimInstance Win32_Process |
    Where-Object {
        if ($_.Name -ne 'DeepSeekHarnessDesktop.exe' -or -not $_.ExecutablePath) {
            $false
        }
        else {
            $runningExePath = [System.IO.Path]::GetFullPath($_.ExecutablePath)
            $runningExePath.StartsWith($currentPathFull + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        }
    } |
    Select-Object ProcessId, ExecutablePath, CommandLine

$preflight = [pscustomobject]@{
    publishDir = $publishPath
    exe = $exePath
    runtimeRoot = $runtimePath
    currentPath = $desktopCurrentDir
    backupPath = $backupPath
    stagingPath = $stagingPath
    sha256 = $newHash
    bytes = $newBytes
    runningDesktop = $runningDesktop
    preflightOnly = [bool]$PreflightOnly
}

if ($PreflightOnly) {
    $preflight | ConvertTo-Json -Depth 5
    exit 0
}

if ($runningDesktop -and -not $AllowStopDesktop) {
    throw "Production desktop shell is running; pass -AllowStopDesktop only after confirming it is safe to close."
}

if ($runningDesktop) {
    foreach ($process in $runningDesktop) {
        Stop-Process -Id $process.ProcessId -Force
    }
    Start-Sleep -Milliseconds 800
}

New-Item -ItemType Directory -Path $desktopRoot -Force | Out-Null
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null

Copy-Item -LiteralPath $publishPath -Destination $stagingPath -Recurse -Force

try {
    if (Test-Path -LiteralPath $desktopCurrentDir) {
        Move-Item -LiteralPath $desktopCurrentDir -Destination ([System.IO.Path]::Combine($backupPath, 'current')) -Force
    }

    Move-Item -LiteralPath $stagingPath -Destination $desktopCurrentDir -Force
}
catch {
    if ((-not (Test-Path -LiteralPath $desktopCurrentDir)) -and (Test-Path -LiteralPath ([System.IO.Path]::Combine($backupPath, 'current')))) {
        Move-Item -LiteralPath ([System.IO.Path]::Combine($backupPath, 'current')) -Destination $desktopCurrentDir -Force
    }

    throw
}

$manifest = if (Test-Path -LiteralPath $manifestPath) {
    Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
else {
    [pscustomobject]@{
        schemaVersion = 3
        application = 'DeepSeek Harness'
        runtimeRoot = $runtimePath
    }
}

if (-not $manifest.PSObject.Properties['desktopShell']) {
    $manifest | Add-Member -MemberType NoteProperty -Name desktopShell -Value ([pscustomobject]@{})
}

Set-JsonProperty $manifest 'modifiedAt' (Get-Date).ToString('o')
Set-JsonProperty $manifest.desktopShell 'path' ([System.IO.Path]::Combine($desktopCurrentDir, 'DeepSeekHarnessDesktop.exe'))
Set-JsonProperty $manifest.desktopShell 'source' ([System.IO.Path]::Combine((Get-Location).Path, 'apps\desktop-shell'))
Set-JsonProperty $manifest.desktopShell 'technology' '.NET 8 WinForms + Microsoft WebView2'
Set-JsonProperty $manifest.desktopShell 'sha256' $newHash
Set-JsonProperty $manifest.desktopShell 'bytes' $newBytes
Set-JsonProperty $manifest.desktopShell 'singleInstance' $true
Set-JsonProperty $manifest.desktopShell 'webViewUserData' ([System.IO.Path]::Combine($runtimePath, 'state\webview2'))
Set-JsonProperty $manifest.desktopShell 'lastBackup' $backupPath
Set-JsonProperty $manifest.desktopShell 'titlebarModes' @('native-panel', 'custom')
Set-JsonProperty $manifest.desktopShell 'embeddedBrowserBridge' $true
Set-JsonProperty $manifest.desktopShell 'updatedAt' (Get-Date).ToString('o')

$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

[pscustomobject]@{
    installed = $true
    currentPath = $desktopCurrentDir
    backupPath = $backupPath
    sha256 = $newHash
    bytes = $newBytes
    manifest = $manifestPath
} | ConvertTo-Json -Depth 5
