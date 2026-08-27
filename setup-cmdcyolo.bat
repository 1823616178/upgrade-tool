@echo off
chcp 65001 > nul
title 一键配置 cmdcyolo

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%scripts\setup-cmdcyolo.ps1"

if not exist "%PS_SCRIPT%" (
    echo 错误：找不到 %PS_SCRIPT%
    pause
    exit /b 1
)

echo 正在配置 cmdcyolo 到 PowerShell Profile ...
echo.

REM 优先使用 PowerShell 7+，不存在则回退到 Windows PowerShell 5.1
where pwsh.exe >nul 2>nul
if %errorlevel% == 0 (
    pwsh.exe -ExecutionPolicy Bypass -NoProfile -File "%PS_SCRIPT%"
) else (
    powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%PS_SCRIPT%"
)

exit /b %ERRORLEVEL%