<#
.SYNOPSIS
    AI Code Tool Updater - Windows 代码签名 & 打包脚本
.DESCRIPTION
    自动完成以下流程：
    1. 检查/生成自签名代码签名证书 (certificate.pfx)
    2. 使用 electron-builder 打包并签名
    3. 验证签名结果
.USAGE
    # 默认打包（自动检查证书，没有就生成）
    .\scripts\sign-and-build.ps1

    # 仅生成证书，不打包
    .\scripts\sign-and-build.ps1 -CertOnly

    # 强制重新生成证书
    .\scripts\sign-and-build.ps1 -ForceNewCert

    # 使用指定的证书文件
    .\scripts\sign-and-build.ps1 -CertPath "C:\path\to\my-cert.pfx" -CertPassword "mypassword"
#>

param(
    # 证书文件路径，默认为 build/certificate.pfx
    [string]$CertPath = "",

    # 证书密码；不传时依次读取 CSC_KEY_PASSWORD、build/.cert-password，或交互输入
    [string]$CertPassword = "",

    # 证书主题名称
    [string]$Subject = "AI Code Tool Updater",

    # 证书有效期（年）
    [int]$ValidYears = 3,

    # 仅生成证书，不执行打包
    [switch]$CertOnly,

    # 强制重新生成证书（即使已存在）
    [switch]$ForceNewCert,

    # 跳过签名验证
    [switch]$SkipVerify
)

# ============================================================
# 配置
# ============================================================
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BuildDir = Join-Path $ProjectRoot "build"
$DistDir = Join-Path $ProjectRoot "dist"
$PasswordFile = Join-Path $BuildDir ".cert-password"

if (-not $CertPath) {
    $CertPath = Join-Path $BuildDir "certificate.pfx"
}

# ============================================================
# 辅助函数
# ============================================================
function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "===> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  [X] $Message" -ForegroundColor Red
}

function Resolve-CertPassword {
    if ($CertPassword) { return $CertPassword }
    if ($env:CSC_KEY_PASSWORD) { return $env:CSC_KEY_PASSWORD }

    # 本地密码文件（.gitignore 已排除，不会提交）
    if (Test-Path $PasswordFile) {
        $saved = Get-Content -Path $PasswordFile -Raw -ErrorAction SilentlyContinue
        if ($saved -and $saved.Trim()) { return $saved.Trim() }
    }

    if (Test-Path $CertPath) {
        if (-not [Environment]::UserInteractive) {
            throw "证书已存在但未提供密码，请通过 -CertPassword 或 CSC_KEY_PASSWORD 传入"
        }
        Write-Warn "未提供证书密码，请在弹出的提示中输入"
        $secure = Read-Host "请输入 PFX 密码" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    # 首次生成证书：随机生成强密码并保存到本地密码文件
    $generated = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    if (-not (Test-Path $BuildDir)) {
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    }
    [IO.File]::WriteAllText($PasswordFile, $generated)
    Write-Success "已生成随机证书密码并保存到: $PasswordFile（请勿提交）"
    return $generated
}

# ============================================================
# 1. 证书处理
# ============================================================
function Ensure-Certificate {
    Write-Step "检查代码签名证书"

    if ((Test-Path $CertPath) -and (-not $ForceNewCert)) {
        Write-Success "证书已存在: $CertPath"

        # 验证证书是否有效
        try {
            $secPass = ConvertTo-SecureString -String $CertPassword -Force -AsPlainText
            $pfx = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertPath, $secPass)

            if ($pfx.NotAfter -lt (Get-Date)) {
                Write-Warn "证书已过期 (过期时间: $($pfx.NotAfter))，将重新生成"
                $pfx.Dispose()
            } else {
                $daysLeft = ($pfx.NotAfter - (Get-Date)).Days
                Write-Success "证书有效，剩余 $daysLeft 天 (到期: $($pfx.NotAfter.ToString('yyyy-MM-dd')))"
                Write-Success "指纹: $($pfx.Thumbprint)"
                $pfx.Dispose()
                return
            }
        } catch {
            Write-Warn "证书验证失败: $_"
            Write-Warn "将重新生成证书"
        }
    }

    # 生成新的自签名证书
    Write-Step "生成自签名代码签名证书"
    Write-Host "  主题: CN=$Subject"
    Write-Host "  有效期: $ValidYears 年"
    Write-Host "  输出: $CertPath"

    # 确保 build 目录存在
    if (-not (Test-Path $BuildDir)) {
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    }

    # 创建自签名证书
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=$Subject" `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter (Get-Date).AddYears($ValidYears) `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256

    # 导出为 PFX
    $secPass = ConvertTo-SecureString -String $CertPassword -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath $CertPath -Password $secPass | Out-Null

    Write-Success "证书生成成功!"
    Write-Success "指纹: $($cert.Thumbprint)"
    Write-Success "文件: $CertPath"

    # 清理证书存储中的临时证书（可选）
    # Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
}

# ============================================================
# 2. 执行打包
# ============================================================
function Start-Build {
    Write-Step "开始 electron-builder 打包 (Windows)"

    # 设置环境变量（electron-builder 也会读取这些）
    $env:CSC_LINK = $CertPath
    $env:CSC_KEY_PASSWORD = $CertPassword

    Push-Location $ProjectRoot
    try {
        npx electron-builder --win
        if ($LASTEXITCODE -ne 0) {
            throw "electron-builder 打包失败 (exit code: $LASTEXITCODE)"
        }
        Write-Success "打包完成!"
    } finally {
        Pop-Location
        # 清理环境变量
        Remove-Item Env:\CSC_LINK -ErrorAction SilentlyContinue
        Remove-Item Env:\CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    }
}

# ============================================================
# 3. 验证签名
# ============================================================
function Verify-Signature {
    Write-Step "验证签名结果"

    $unpackedDir = Join-Path $DistDir "win-unpacked"
    $exeName = "AI Code Tool Updater.exe"
    $exePath = Join-Path $unpackedDir $exeName

    if (-not (Test-Path $exePath)) {
        Write-Warn "未找到 $exePath，跳过签名验证"
        return
    }

    $sig = Get-AuthenticodeSignature -FilePath $exePath

    switch ($sig.Status) {
        "Valid" {
            Write-Success "$exeName 签名有效"
            Write-Success "签名者: $($sig.SignerCertificate.Subject)"
            Write-Success "算法: $($sig.SignerCertificate.SignatureAlgorithm.FriendlyName)"
        }
        "UnknownError" {
            Write-Warn "$exeName 签名状态: UnknownError (自签名证书通常会出现此状态)"
            Write-Warn "签名者: $($sig.SignerCertificate.Subject)"
        }
        "NotSigned" {
            Write-Fail "$exeName 未签名!"
        }
        default {
            Write-Warn "$exeName 签名状态: $($sig.Status)"
        }
    }

    # 同时检查安装包
    Write-Host ""
    $installers = Get-ChildItem -Path $DistDir -Filter "*.exe" -File | Where-Object { $_.Directory.Name -eq "dist" }
    foreach ($installer in $installers) {
        $instSig = Get-AuthenticodeSignature -FilePath $installer.FullName
        $statusColor = if ($instSig.Status -eq "Valid") { "Green" } else { "Yellow" }
        Write-Host "  $($installer.Name): $($instSig.Status)" -ForegroundColor $statusColor
    }
}

# ============================================================
# 4. 输出摘要
# ============================================================
function Show-Summary {
    Write-Step "打包产物"

    if (Test-Path $DistDir) {
        $artifacts = Get-ChildItem -Path $DistDir -Filter "*.exe" -File -Recurse |
            Where-Object { $_.FullName -notlike "*\win-unpacked\*" -or $_.Name -eq "AI Code Tool Updater.exe" }

        foreach ($file in $artifacts) {
            $sizeMB = [math]::Round($file.Length / 1MB, 2)
            Write-Host "  $($file.Name)  ($sizeMB MB)  ->  $($file.FullName)" -ForegroundColor White
        }
    }
}

# ============================================================
# 主流程
# ============================================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  AI Code Tool Updater - 签名打包脚本" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

try {
    # 1. 解析证书密码（优先参数 / 环境变量 / 本地密码文件，最后交互输入）
    $CertPassword = Resolve-CertPassword
    # 2. 确保证书存在
    Ensure-Certificate

    if ($CertOnly) {
        Write-Host ""
        Write-Success "仅证书模式，跳过打包"
        exit 0
    }

    # 3. 打包
    Start-Build

    # 4. 验证签名
    if (-not $SkipVerify) {
        Verify-Signature
    }

    # 5. 摘要
    Show-Summary

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  全部完成!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""

} catch {
    Write-Host ""
    Write-Fail "出错了: $_"
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
}
