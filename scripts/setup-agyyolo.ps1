#requires -Version 5.1
<#
.SYNOPSIS
    一键永久配置 agyyolo 函数到 PowerShell Profile。
.DESCRIPTION
    将 function agyyolo { agy --dangerously-skip-permissions } 写入当前用户的
    PowerShell 5.1 与 PowerShell 7+ 的配置文件，使其在新窗口中永久可用。
    如果函数已存在，则跳过写入，避免重复。
#>

$ErrorActionPreference = 'Stop'

# 确保中文提示在 Windows 控制台正确显示
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$functionName = 'agyyolo'
$functionBody = @'
function agyyolo {
    agy --dangerously-skip-permissions
}
'@

function EnsureProfile($profilePath) {
    if ([string]::IsNullOrWhiteSpace($profilePath)) {
        return $null
    }

    $dir = Split-Path -Parent $profilePath
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    if (!(Test-Path $profilePath)) {
        New-Item -ItemType File -Path $profilePath -Force | Out-Null
    }
    return $profilePath
}

function InstallFunctionToProfile($profilePath) {
    if ([string]::IsNullOrWhiteSpace($profilePath)) {
        return @{ ok = $false; reason = 'Profile 路径为空' }
    }

    $content = Get-Content -Path $profilePath -Raw -ErrorAction SilentlyContinue
    if ($content -and $content -match "function\s+$functionName\b") {
        return @{ ok = $true; reason = '已存在，跳过' }
    }

    # 确保文件末尾有换行，再追加函数
    $ending = if ($content -and !$content.EndsWith("`n")) { "`n`n" } else { "" }
    "$ending$functionBody" | Out-File -FilePath $profilePath -Append -Encoding utf8 -NoNewline

    return @{ ok = $true; reason = '已写入' }
}

# 同时处理 PowerShell 5.1 与 PowerShell 7+ 的 CurrentUserCurrentHost Profile
$profiles = @()

# 当前正在运行的 PowerShell 的 $PROFILE（由 PowerShell 自己解析，最准确）
$profiles += EnsureProfile $PROFILE

# 「文档」已知文件夹可能被 OneDrive 重定向，不能直接用 %USERPROFILE%\Documents
$documents = [Environment]::GetFolderPath('MyDocuments')
if ([string]::IsNullOrWhiteSpace($documents)) {
    $documents = Join-Path $env:USERPROFILE 'Documents'
}
$profiles += EnsureProfile (Join-Path $documents 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1')
$profiles += EnsureProfile (Join-Path $documents 'PowerShell\Microsoft.PowerShell_profile.ps1')

# 去重后逐个安装
$results = @()
$seen = @{}
foreach ($p in $profiles) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    $key = $p.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true

    $result = InstallFunctionToProfile $p
    $results += [PSCustomObject]@{
        Profile = $p
        Status  = if ($result.ok) { 'OK' } else { 'FAIL' }
        Reason  = $result.reason
    }
}

# 输出结果
Write-Host ""
Write-Host "agyyolo 配置结果：" -ForegroundColor Cyan
foreach ($r in $results) {
    $color = if ($r.Status -eq 'OK') { 'Green' } else { 'Red' }
    Write-Host "  [$($r.Status)] $($r.Profile) - $($r.Reason)" -ForegroundColor $color
}

# 检查 agy 命令是否可用
$agyFound = $null -ne (Get-Command agy -ErrorAction SilentlyContinue)
Write-Host ""
if ($agyFound) {
    Write-Host "agy 命令已找到，配置完成。请重新打开 PowerShell 窗口使用 agyyolo。" -ForegroundColor Green
} else {
    Write-Host "警告：未找到 agy 命令。请确保 agy 所在目录已加入系统 PATH，" -ForegroundColor Yellow
    Write-Host "       否则 agyyolo 函数仍会报错。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "按任意键退出..." -NoNewLine
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
Write-Host ""
