$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$requiredFiles = @(
    'apps\desktop-shell\DeepSeekHarnessDesktop.csproj',
    'apps\desktop-shell\Program.cs',
    'packages\openai-codex-oauth\package.json',
    'packages\openai-codex-oauth\lib\index.js',
    'packages\openai-codex-oauth\lib\store.js',
    'packages\openai-codex-oauth\test\oauth.test.mjs',
    'scripts\windows-launcher\Start-DeepSeekHarness.ps1',
    'scripts\windows-launcher\Stop-DeepSeekHarness.ps1'
)

foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $workspace $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing source baseline file: $relativePath"
    }
}

foreach ($privateDirectory in @('.dsh', 'state', 'logs', 'backups')) {
    $path = Join-Path $workspace $privateDirectory
    if (Test-Path -LiteralPath $path) {
        throw "Private runtime directory is not allowed in the workspace: $privateDirectory"
    }
}

$searchRoots = @('apps', 'packages', 'scripts') | ForEach-Object { Join-Path $workspace $_ }
$textExtensions = @('.cs', '.js', '.mjs', '.ts', '.tsx', '.ps1', '.json', '.md', '.txt', '.yml', '.yaml')
$textFiles = Get-ChildItem -LiteralPath $searchRoots -Recurse -File -ErrorAction Stop |
    Where-Object {
        $_.Extension -in $textExtensions -and
        $_.FullName -notmatch '\\node_modules\\|\\bin\\|\\obj\\'
    }

$secretPatterns = @(
    'sk-[A-Za-z0-9_-]{20,}',
    'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.',
    '(?i)(access|refresh)[_-]?token\s*[:=]\s*["''][A-Za-z0-9._-]{20,}["'']'
)

$findings = $textFiles | Select-String -Pattern $secretPatterns -AllMatches
if ($findings) {
    $summary = $findings | ForEach-Object { "$($_.Path):$($_.LineNumber)" }
    throw "Potential plaintext credential found in source baseline: $($summary -join ', ')"
}

Write-Output "Source baseline check passed: $($requiredFiles.Count) required files; no private runtime directory or potential plaintext credential found."
