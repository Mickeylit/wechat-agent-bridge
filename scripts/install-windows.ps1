#requires -Version 5.1
<#
.SYNOPSIS
Install this skill into Codex, Claude Code, or both on Windows. No Python needed.
.EXAMPLE
& '.\scripts\install-windows.ps1' -Target both
.EXAMPLE
& '.\scripts\install-windows.ps1' -Target both -Update
#>
[CmdletBinding()]
param(
    [ValidateSet('both', 'codex', 'claude')]
    [string]$Target = 'both',
    [switch]$Update,
    [string]$CodexRoot,
    [string]$ClaudeRoot,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SkillName = 'wechat-agent-bridge'

function Get-LiteralAttributes {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    try { return [System.IO.File]::GetAttributes($LiteralPath) }
    catch [System.IO.FileNotFoundException] { return $null }
    catch [System.IO.DirectoryNotFoundException] { return $null }
}

function Test-LiteralExists {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    return ($null -ne (Get-LiteralAttributes -LiteralPath $LiteralPath))
}

function Assert-NoReparseChain {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $current = [System.IO.Path]::GetFullPath($LiteralPath)
    while (-not [string]::IsNullOrEmpty($current)) {
        $attributes = Get-LiteralAttributes -LiteralPath $current
        if (($null -ne $attributes) -and (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Symbolic links and reparse points are not supported: $current"
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-SkillIdentity {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    Assert-NoReparseChain -LiteralPath $LiteralPath
    $attributes = Get-LiteralAttributes -LiteralPath $LiteralPath
    if (($null -eq $attributes) -or (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0)) {
        throw "Skill directory is missing or invalid: $LiteralPath"
    }
    $skillFile = Join-Path -Path $LiteralPath -ChildPath 'SKILL.md'
    Assert-NoReparseChain -LiteralPath $skillFile
    if (-not [System.IO.File]::Exists($skillFile)) { throw "SKILL.md is missing: $LiteralPath" }
    $text = [System.IO.File]::ReadAllText($skillFile)
    $frontmatter = [regex]::Match($text, '\A---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|\z)')
    if (-not $frontmatter.Success) { throw "SKILL.md needs YAML frontmatter: $LiteralPath" }
    $names = [regex]::Matches($frontmatter.Groups['yaml'].Value, '(?m)^name[ \t]*:[ \t]*(?<name>[^\r\n]+)$')
    $expected = '^(?:wechat-agent-bridge|"wechat-agent-bridge"|''wechat-agent-bridge'')[ \t]*(?:#.*)?$'
    if (($names.Count -ne 1) -or ($names[0].Groups['name'].Value.Trim() -notmatch $expected)) {
        throw "Refusing a different or missing skill name; expected ${SkillName}: $LiteralPath"
    }
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    Assert-NoReparseChain -LiteralPath $LiteralPath
    foreach ($item in @(Get-ChildItem -LiteralPath $LiteralPath -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing an installation containing a symbolic link or reparse point: $($item.FullName)"
        }
        if ($item.PSIsContainer) { Assert-NoReparseTree -LiteralPath $item.FullName }
    }
}

function Get-SourceFiles {
    param([Parameter(Mandatory = $true)][string]$Source)
    $files = New-Object 'System.Collections.Generic.List[string]'
    $files.Add('SKILL.md')
    if (Test-LiteralExists -LiteralPath (Join-Path $Source 'README.md')) { $files.Add('README.md') }
    $layouts = @(
        @{ Directory = 'scripts'; Extensions = @('.py', '.ps1') },
        @{ Directory = 'references'; Extensions = @('.md') },
        @{ Directory = 'agents'; Extensions = @('.yaml') },
        @{ Directory = 'assets\bridge\lib'; Extensions = @('.mjs') },
        @{ Directory = 'assets\bridge\test'; Extensions = @('.mjs') }
    )
    foreach ($layout in $layouts) {
        $folder = Join-Path $Source $layout.Directory
        Assert-NoReparseChain -LiteralPath $folder
        if (-not (Test-LiteralExists -LiteralPath $folder)) { continue }
        if (-not [System.IO.Directory]::Exists($folder)) { throw "Invalid source directory: $folder" }
        foreach ($item in @(Get-ChildItem -LiteralPath $folder -Force | Sort-Object -Property Name)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Symbolic links are not packaged: $($item.FullName)"
            }
            if ($item.PSIsContainer -or $item.Name.StartsWith('.')) { continue }
            if ($layout.Extensions -contains $item.Extension.ToLowerInvariant()) {
                $files.Add((Join-Path $layout.Directory $item.Name))
            }
        }
    }
    foreach ($name in @('cli.mjs', 'package.json', 'package-lock.json')) {
        $relative = Join-Path 'assets\bridge' $name
        if (Test-LiteralExists -LiteralPath (Join-Path $Source $relative)) { $files.Add($relative) }
    }
    foreach ($relative in $files) {
        $file = Join-Path $Source $relative
        Assert-NoReparseChain -LiteralPath $file
        if (-not [System.IO.File]::Exists($file)) { throw "Invalid source file: $relative" }
    }
    return $files.ToArray()
}

function Test-ContainsPath {
    param([string]$Parent, [string]$Child)
    $prefix = $Parent.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    return $Child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RecoveryRoot {
    param([Parameter(Mandatory = $true)][string]$Installation, [switch]$Create)
    $skillsRoot = [System.IO.Path]::GetDirectoryName($Installation)
    $ownerRoot = [System.IO.Path]::GetDirectoryName($skillsRoot)
    if ([string]::IsNullOrEmpty($ownerRoot)) { throw 'A sibling backup directory outside the skills directory is required.' }
    $recoveryRoot = [System.IO.Path]::GetFullPath((Join-Path $ownerRoot '.skill-backups'))
    if (($recoveryRoot -ieq $skillsRoot) -or (Test-ContainsPath $skillsRoot $recoveryRoot)) {
        throw "Cannot place backups outside the skills discovery directory: $skillsRoot"
    }
    Assert-NoReparseChain -LiteralPath $skillsRoot
    Assert-NoReparseChain -LiteralPath $recoveryRoot
    # Mounted volumes and junctions are reparse points and were rejected above;
    # equal Windows/UNC roots therefore keep Directory.Move on the same volume.
    if ([System.IO.Path]::GetPathRoot($skillsRoot) -ine [System.IO.Path]::GetPathRoot($recoveryRoot)) {
        throw 'The sibling .skill-backups directory must be on the same volume as the skills directory.'
    }
    if ((Test-LiteralExists -LiteralPath $recoveryRoot) -and (-not [System.IO.Directory]::Exists($recoveryRoot))) {
        throw "Backup path is not a directory: $recoveryRoot"
    }
    if ($Create) {
        [void][System.IO.Directory]::CreateDirectory($recoveryRoot)
        Assert-NoReparseChain -LiteralPath $recoveryRoot
    }
    return $recoveryRoot
}

function Copy-SourceFiles {
    param([string]$Source, [string[]]$Files, [string]$Destination)
    foreach ($relative in $Files) {
        $inputFile = Join-Path $Source $relative
        Assert-NoReparseChain -LiteralPath $inputFile
        $outputFile = Join-Path $Destination $relative
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($outputFile))
        [System.IO.File]::Copy($inputFile, $outputFile, $false)
    }
}

function Restore-Installations {
    param([object[]]$Plans)
    $problems = New-Object 'System.Collections.Generic.List[string]'
    for ($index = $Plans.Count - 1; $index -ge 0; $index--) {
        $plan = $Plans[$index]
        try {
            if ($plan.Published) {
                # Preserve the new copy as well, including any concurrently added
                # files. Never recursively delete a published installation here.
                Assert-SkillIdentity -LiteralPath $plan.Path
                $hash = (Get-FileHash -LiteralPath (Join-Path $plan.Path 'SKILL.md') -Algorithm SHA256).Hash
                if ($hash -ne $plan.NewSkillHash) {
                    throw "Published installation changed; preserved at $($plan.Path)"
                }
                $recoveryRoot = Get-RecoveryRoot -Installation $plan.Path -Create
                $recovery = Join-Path $recoveryRoot ('.' + $SkillName + '.failed-' + [guid]::NewGuid().ToString('N'))
                [System.IO.Directory]::Move($plan.Path, $recovery)
                Write-Host "New copy preserved after failed installation: $recovery"
            }
            if ($null -ne $plan.Backup) {
                if (Test-LiteralExists -LiteralPath $plan.Path) { throw "Destination reappeared: $($plan.Path)" }
                [System.IO.Directory]::Move($plan.Backup, $plan.Path)
            }
        }
        catch { $problems.Add("Recovery needs attention; backup: $($plan.Backup); destination: $($plan.Path); $($_.Exception.Message)") }
    }
    return $problems.ToArray()
}

$plans = New-Object 'System.Collections.Generic.List[object]'
$locks = New-Object 'System.Collections.Generic.List[object]'
try {
    $source = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    Assert-SkillIdentity -LiteralPath $source
    $files = @(Get-SourceFiles -Source $source)
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { throw 'USERPROFILE is not set; run this installer in Windows PowerShell.' }
    if ([string]::IsNullOrWhiteSpace($CodexRoot)) { $CodexRoot = Join-Path $env:USERPROFILE '.agents\skills' }
    if ([string]::IsNullOrWhiteSpace($ClaudeRoot)) { $ClaudeRoot = Join-Path $env:USERPROFILE '.claude\skills' }
    $destinations = New-Object 'System.Collections.Generic.List[string]'
    if ($Target -in @('both', 'codex')) { $destinations.Add([System.IO.Path]::GetFullPath((Join-Path $CodexRoot $SkillName))) }
    if ($Target -in @('both', 'claude')) { $destinations.Add([System.IO.Path]::GetFullPath((Join-Path $ClaudeRoot $SkillName))) }
    foreach ($destination in $destinations) {
        Assert-NoReparseChain -LiteralPath $destination
        if (($destination -ieq $source) -or (Test-ContainsPath $source $destination) -or (Test-ContainsPath $destination $source)) {
            throw 'Install outside the source skill directory and its ancestors.'
        }
        foreach ($plan in $plans) {
            if (($destination -ieq $plan.Path) -or (Test-ContainsPath $plan.Path $destination) -or (Test-ContainsPath $destination $plan.Path)) {
                throw 'Installation destinations must be different and must not contain each other.'
            }
        }
        $exists = Test-LiteralExists -LiteralPath $destination
        if ($exists) {
            if (-not $Update) { throw "Already exists; nothing overwritten. Use -Update to update this matching skill: $destination" }
            Assert-SkillIdentity -LiteralPath $destination
            Assert-NoReparseTree -LiteralPath $destination
        }
        $recoveryRoot = Get-RecoveryRoot -Installation $destination
        if (($recoveryRoot -ieq $source) -or (Test-ContainsPath $source $recoveryRoot)) {
            throw 'The backup directory must be outside the source skill.'
        }
        $plans.Add(@{ Path = $destination; Existed = $exists; RecoveryRoot = $recoveryRoot; Stage = $null; Backup = $null; Published = $false; NewSkillHash = $null })
    }
    foreach ($plan in $plans) {
        foreach ($otherPlan in $plans) {
            $otherSkillsRoot = [System.IO.Path]::GetDirectoryName($otherPlan.Path)
            if (($plan.RecoveryRoot -ieq $otherSkillsRoot) -or (Test-ContainsPath $otherSkillsRoot $plan.RecoveryRoot)) {
                throw 'The backup directory must be outside every skills discovery directory.'
            }
        }
    }
    if ($DryRun) {
        foreach ($plan in $plans) { Write-Host "Would install/update: $($plan.Path)" }
        Write-Host "Source files: $($files.Count). Dry run: no files changed."
        exit 0
    }
    try {
        # Exclusive sibling lock files serialize cooperating installers. A lock
        # left after a crash is not deleted automatically; inspect it first.
        foreach ($plan in @($plans | Sort-Object -Property Path)) {
            $parent = [System.IO.Path]::GetDirectoryName($plan.Path)
            [void][System.IO.Directory]::CreateDirectory($parent)
            Assert-NoReparseChain -LiteralPath $parent
            $lockPath = Join-Path $parent ('.' + $SkillName + '.install-lock')
            $stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $locks.Add(@{ Path = $lockPath; Stream = $stream })
        }
        foreach ($plan in $plans) {
            $recoveryRoot = Get-RecoveryRoot -Installation $plan.Path -Create
            $plan.Stage = Join-Path $recoveryRoot ('.' + $SkillName + '.stage-' + [guid]::NewGuid().ToString('N'))
            [void][System.IO.Directory]::CreateDirectory($plan.Stage)
            Copy-SourceFiles -Source $source -Files $files -Destination $plan.Stage
            $plan.NewSkillHash = (Get-FileHash -LiteralPath (Join-Path $plan.Stage 'SKILL.md') -Algorithm SHA256).Hash
        }
        foreach ($plan in $plans) {
            Assert-NoReparseChain -LiteralPath $plan.Path
            if ($plan.Existed) {
                Assert-SkillIdentity -LiteralPath $plan.Path
                Assert-NoReparseTree -LiteralPath $plan.Path
                $backupName = '.' + $SkillName + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')
                $recoveryRoot = Get-RecoveryRoot -Installation $plan.Path -Create
                $backupPath = Join-Path $recoveryRoot $backupName
                [System.IO.Directory]::Move($plan.Path, $backupPath)
                $plan.Backup = $backupPath
            }
            if (Test-LiteralExists -LiteralPath $plan.Path) { throw "Destination appeared during installation; preserved: $($plan.Path)" }
            # Directory.Move refuses an existing destination, including an empty
            # one that another process may have created after the previous check.
            [System.IO.Directory]::Move($plan.Stage, $plan.Path)
            $plan.Published = $true
        }
    }
    catch {
        $originalError = $_.Exception.Message
        $recoveryProblems = @(Restore-Installations -Plans ($plans.ToArray()))
        if ($recoveryProblems.Count -gt 0) { throw ($originalError + [Environment]::NewLine + ($recoveryProblems -join [Environment]::NewLine)) }
        throw $originalError
    }
    finally {
        foreach ($plan in $plans) {
            if (($null -ne $plan.Stage) -and (Test-LiteralExists -LiteralPath $plan.Stage)) {
                Remove-Item -LiteralPath $plan.Stage -Recurse -Force
            }
        }
        foreach ($lock in $locks) {
            $lock.Stream.Dispose()
            [System.IO.File]::Delete($lock.Path)
        }
    }
    foreach ($plan in $plans) {
        Write-Host "Installed: $($plan.Path)"
        if ($null -ne $plan.Backup) {
            Write-Host "Previous copy preserved: $($plan.Backup)"
            Write-Host 'To restore: move the new installation aside, then move this backup back to the installation path.'
        }
    }
    Write-Host 'Only skill files were installed. No Python, model, network request, WeChat pairing, or background service was started.'
    Write-Host 'Restart Codex or Claude Code, then invoke the wechat-agent-bridge skill.'
}
catch {
    [Console]::Error.WriteLine('Installation failed: ' + $_.Exception.Message)
    exit 1
}
