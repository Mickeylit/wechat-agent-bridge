#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [ValidateSet('codex', 'claude')][string]$Engine = 'codex',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Assert-OrdinaryPath([string]$PathValue) {
    $current = [IO.Path]::GetFullPath($PathValue)
    while (-not [string]::IsNullOrEmpty($current)) {
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($current) }
        catch [IO.FileNotFoundException] { }
        catch [IO.DirectoryNotFoundException] { }
        if (($null -ne $attributes) -and (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'Symbolic links and junctions are not accepted.'
        }
        # A missing destination leaf still requires checking every existing
        # ancestor. Literal .NET paths never expand wildcard characters.
        $ancestor = [IO.Path]::GetDirectoryName($current)
        if ($ancestor -eq $current) { break }
        $current = $ancestor
    }
}

$skillRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $skillRoot 'assets\bridge'
if (-not [IO.Path]::IsPathRooted($Destination) -or $Destination -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') {
    throw 'Destination must be an absolute Windows path.'
}
$target = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($target.Equals($skillRoot, [StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($skillRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Create the runtime outside the skill directory.'
}
$parent = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Create the parent directory first.' }
Assert-OrdinaryPath $target
Assert-OrdinaryPath $source
if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $target -PathType Container) -or @(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
        throw 'Destination must be new or empty. Existing files will not be overwritten.'
    }
}

$files = @('cli.mjs', 'package.json', 'package-lock.json')
foreach ($folder in @('lib', 'test')) {
    $directory = Join-Path $source $folder
    Assert-OrdinaryPath $directory
    foreach ($item in Get-ChildItem -LiteralPath $directory -File -Force) {
        if ($item.Name -match '^[A-Za-z0-9][A-Za-z0-9_.-]*\.mjs$') {
            $files += Join-Path $folder $item.Name
        }
    }
}
foreach ($relative in $files) {
    $inputPath = Join-Path $source $relative
    Assert-OrdinaryPath $inputPath
    if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Missing source: $relative" }
}
if ($DryRun) {
    Write-Output "Would prepare $Engine runtime in $target ($($files.Count) source files). No files changed."
    return
}

$temporary = Join-Path $parent ('.wechat-prepare-' + [Guid]::NewGuid().ToString('N'))
Assert-OrdinaryPath $temporary
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    foreach ($relative in $files) {
        $inputPath = Join-Path $source $relative
        Assert-OrdinaryPath $inputPath
        $outputPath = Join-Path $temporary $relative
        Assert-OrdinaryPath $outputPath
        [IO.Directory]::CreateDirectory((Split-Path -Parent $outputPath)) | Out-Null
        Assert-OrdinaryPath $outputPath
        [IO.File]::Copy($inputPath, $outputPath, $false)
    }
    $configuration = @{ engine = $Engine; stateDir = './.state' } | ConvertTo-Json
    $configurationPath = Join-Path $temporary 'bridge.config.json'
    Assert-OrdinaryPath $configurationPath
    [IO.File]::WriteAllText($configurationPath, $configuration, [Text.UTF8Encoding]::new($false))
    Assert-OrdinaryPath $target
    if (Test-Path -LiteralPath $target) {
        if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) { throw 'Destination changed during preparation.' }
        [IO.Directory]::Delete($target, $false)
    }
    Assert-OrdinaryPath $temporary
    Assert-OrdinaryPath $target
    [IO.Directory]::Move($temporary, $target)
} finally {
    Assert-OrdinaryPath $temporary
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
$quotedTarget = "'" + $target.Replace("'", "''") + "'"
Write-Output "Prepared: $target"
Write-Output 'Next commands (not executed):'
Write-Output "Set-Location -LiteralPath $quotedTarget"
Write-Output 'npm.cmd ci --ignore-scripts --no-audit --no-fund'
Write-Output 'node cli.mjs doctor'
Write-Output 'node cli.mjs login --web --auto-start'
