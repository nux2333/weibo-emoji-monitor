@echo off
setlocal EnableExtensions

rem Install Comment Assistant Login Helper into the current user's Startup folder.
rem It will start only after this Windows user logs into the interactive desktop.

set "HELPER=%~dp0start-login-helper.cmd"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%STARTUP%\Comment Assistant Login Helper.cmd"

if not exist "%HELPER%" (
  echo [ERROR] Helper script not found: "%HELPER%"
  exit /b 1
)

if not exist "%STARTUP%" mkdir "%STARTUP%" >nul 2>nul

> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo start "Comment Assistant Login Helper" /min cmd.exe /c ""%HELPER%""

if errorlevel 1 (
  echo [ERROR] Could not create Startup launcher: "%LAUNCHER%"
  exit /b 2
)

echo [OK] Login Helper autostart installed.
echo [OK] It will start automatically whenever %USERNAME% logs into Windows.
echo [OK] Launcher: "%LAUNCHER%"
echo.
echo Starting it now...
start "Comment Assistant Login Helper" /min cmd.exe /c ""%HELPER%""
exit /b 0
