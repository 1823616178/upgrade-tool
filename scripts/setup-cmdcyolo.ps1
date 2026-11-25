#requires -Version 5.1
param(
    [switch]$Remove
)

<#
.SYNOPSIS
    配置或撤销 cmdcyolo PowerShell Profile 函数。
.DESCRIPTION
    安装会将 cmdc --yolo 写入当前用户的 PowerShell Profile，
    每次安装都要求输入 YES 明确确认；撤销使用 -Remove，并要求输入 REMOVE。
    只移除本工具标记的代码块或完全匹配的旧版函数定义。
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$beginMarker = '# >>> AI Code Tool Updater: cmdcyolo >>>'
$endMarker = '# <<< AI Code Tool Updater: cmdcyolo <<<'
$managedBlock = @"
$beginMarker
function cmdcyolo {
    cmdc --yolo
}
$endMarker
"@
$legacyPattern = '(?m)^function cmdcyolo[ \t]*\{\r?\n[ \t]+cmdc --yolo\r?\n[ \t]*\}\r?\n?'
$managedPattern = '(?m)^# >>> AI Code Tool Updater: cmdcyolo >>>\r?\nfunction cmdcyolo \{\r?\n    cmdc --yolo\r?\n\}\r?\n# <<< AI Code Tool Updater: cmdcyolo <<<(?:\r?\n|$)'

function Get-ProfilePaths {
    $paths = @()
    if ($PROFILE) { $paths += [string]$PROFILE }
    if ($PROFILE.CurrentUserCurrentHost) { $paths += [string]$PROFILE.CurrentUserCurrentHost }

    $documents = [Environment]::GetFolderPath('MyDocuments')
    if ([string]::IsNullOrWhiteSpace($documents)) {
        $documents = Join-Path $env:USERPROFILE 'Documents'
    }
    $paths += Join-Path $documents 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1'
    $paths += Join-Path $documents 'PowerShell\Microsoft.PowerShell_profile.ps1'

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    return @($paths | Where-Object { ![string]::IsNullOrWhiteSpace($_) -and $seen.Add($_) })
}

function Ensure-Profile([string]$profilePath) {
    $directory = Split-Path -Parent $profilePath
    if (!(Test-Path -LiteralPath $directory)) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    if (!(Test-Path -LiteralPath $profilePath)) {
        [IO.File]::WriteAllText($profilePath, '', [Text.UTF8Encoding]::new($false))
    }
}

function Read-ProfileContent([string]$profilePath) {
    $bytes = [IO.File]::ReadAllBytes($profilePath)
    try {
        $decoder = [Text.UTF8Encoding]::new($false, $true)
        return $decoder.GetString($bytes).TrimStart([char]0xFEFF)
    } catch {
        throw 'Profile 不是有效 UTF-8 编码，原文件未修改；请先备份并转换编码。'
    }
}

function Write-ProfileAtomically([string]$profilePath, [string]$content) {
    $temporaryPath = "$profilePath.$([Guid]::NewGuid().ToString('N')).tmp"
    $bytes = [IO.File]::ReadAllBytes($profilePath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    try {
        [IO.File]::WriteAllText($temporaryPath, $content, [Text.UTF8Encoding]::new($hasBom, $true))
        if (Test-Path -LiteralPath $profilePath) {
            [IO.File]::Replace($temporaryPath, $profilePath, $null)
        } else {
            [IO.File]::Move($temporaryPath, $profilePath)
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-ManagedState([string]$content) {
    $beginCount = [regex]::Matches($content, [regex]::Escape($beginMarker)).Count
    $endCount = [regex]::Matches($content, [regex]::Escape($endMarker)).Count
    if ($beginCount -eq 0 -and $endCount -eq 0) { return 'none' }
    if ($beginCount -eq 1 -and $endCount -eq 1 -and [regex]::IsMatch($content, $managedPattern)) { return 'valid' }
    return 'conflict'
}

function Install-FunctionToProfile([string]$profilePath) {
    Ensure-Profile $profilePath
    $content = Read-ProfileContent $profilePath
    $managedState = Get-ManagedState $content
    if ($managedState -eq 'valid') { return @{ ok = $true; reason = '已由本工具配置' } }
    if ($managedState -eq 'conflict') {
        return @{ ok = $false; reason = '配置标记重复、损坏或内容已修改，未覆盖' }
    }

    $withoutLegacy = [regex]::Replace($content, $legacyPattern, '')
    if ([regex]::IsMatch($withoutLegacy, 'function\s+cmdcyolo\b', 'IgnoreCase')) {
        return @{ ok = $false; reason = '检测到同名自定义函数，未覆盖' }
    }
    $migrated = $withoutLegacy -cne $content
    $ending = if ($withoutLegacy.Length -gt 0 -and !$withoutLegacy.EndsWith("`n")) { "`r`n`r`n" } else { '' }
    Write-ProfileAtomically $profilePath ($withoutLegacy + $ending + $managedBlock + "`r`n")
    $reason = if ($migrated) { '已将旧配置升级为可撤销标记' } else { '已写入' }
    return @{ ok = $true; reason = $reason }
}

function Remove-FunctionFromProfile([string]$profilePath) {
    if (!(Test-Path -LiteralPath $profilePath)) {
        return @{ ok = $true; reason = '配置文件不存在' }
    }
    $content = Read-ProfileContent $profilePath
    $managedState = Get-ManagedState $content
    if ($managedState -eq 'conflict') {
        return @{ ok = $false; reason = '配置标记重复、损坏或内容已修改，未删除' }
    }
    $updated = [regex]::Replace($content, $managedPattern, '')
    $updated = [regex]::Replace($updated, $legacyPattern, '')
    if ($updated -ceq $content) {
        if ([regex]::IsMatch($content, 'function\s+cmdcyolo\b', 'IgnoreCase')) {
            return @{ ok = $false; reason = '存在未由本工具管理的同名函数，未删除' }
        }
        return @{ ok = $true; reason = '没有需要撤销的配置' }
    }
    Write-ProfileAtomically $profilePath $updated
    return @{ ok = $true; reason = '已撤销本工具管理的配置' }
}

if (!$Remove) {
    Write-Host '警告：cmdcyolo 会执行 cmdc --yolo，跳过逐项权限确认。' -ForegroundColor Yellow
    Write-Host '该命令可能允许 cmdc 直接修改文件或运行命令；此配置会持久写入 PowerShell Profile。' -ForegroundColor Yellow
    $answer = Read-Host '确认写入请输入 YES（默认取消）'
    if ($answer -cne 'YES') {
        Write-Host '已取消，未修改任何 Profile。' -ForegroundColor Cyan
        exit 0
    }
    if ($null -eq (Get-Command cmdc -ErrorAction SilentlyContinue)) {
        Write-Error '未检测到 cmdc 命令；请先安装对应 CLI 并配置 PATH。未修改任何 Profile。'
        exit 1
    }
} else {
    Write-Host '将只撤销本工具标记的 cmdcyolo 配置；其它 Profile 内容不会删除。' -ForegroundColor Yellow
    $answer = Read-Host '确认撤销请输入 REMOVE（默认取消）'
    if ($answer -cne 'REMOVE') {
        Write-Host '已取消，未修改任何 Profile。' -ForegroundColor Cyan
        exit 0
    }
}

$operation = if ($Remove) { '撤销' } else { '配置' }
$profiles = Get-ProfilePaths
$results = @()
foreach ($profile in $profiles) {
    try {
        $result = if ($Remove) { Remove-FunctionFromProfile $profile } else { Install-FunctionToProfile $profile }
        $results += [PSCustomObject]@{ Profile = $profile; Ok = $result.ok; Reason = $result.reason }
    } catch {
        $results += [PSCustomObject]@{ Profile = $profile; Ok = $false; Reason = $_.Exception.Message }
    }
}

Write-Host "`n$operation cmdcyolo 配置结果：" -ForegroundColor Cyan
foreach ($result in $results) {
    $status = if ($result.Ok) { 'OK' } else { 'FAIL' }
    $color = if ($result.Ok) { 'Green' } else { 'Red' }
    Write-Host "  [$status] $($result.Profile) - $($result.Reason)" -ForegroundColor $color
}
$success = $results.Count -gt 0 -and @($results | Where-Object { !$_.Ok }).Count -eq 0
if (!$success) {
    Write-Host "部分或全部 Profile $operation失败；请检查上方失败路径。" -ForegroundColor Red
    $exitCode = 1
} else {
    Write-Host "cmdcyolo $operation完成。" -ForegroundColor Green
    $exitCode = 0
}

try {
    Write-Host "`n按任意键退出..." -NoNewLine
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    Write-Host ''
} catch { }
exit $exitCode
