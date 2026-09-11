@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem Weibo Monitor - Windows unattended auto restore
rem Purpose: recover PM2 services after reboot / power failure.
rem NOTE: deployment (git pull / npm install) is intentionally
rem       NOT performed here. Recovery and deployment are separate.
rem ============================================================

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
set "LOG_DIR=%PROJECT_DIR%\logs\windows-autorestore"
set "LOCK_DIR=%TEMP%\weibo-monitor-autorestore.lock"
set "MAX_RETRIES=5"
set "RETRY_WAIT_SECONDS=15"
set "BOOT_WAIT_SECONDS=20"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%I"
if not defined STAMP set "STAMP=unknown"
set "LOG_FILE=%LOG_DIR%\windows-autorestore_%STAMP%.log"

call :main >> "%LOG_FILE%" 2>&1
set "RC=%ERRORLEVEL%"

echo Auto restore finished. ExitCode=%RC%
echo Log: "%LOG_FILE%"

endlocal & exit /b %RC%

:main
echo ============================================================
echo Weibo Monitor - Windows Auto Restore
echo Started: %DATE% %TIME%
echo Project: "%PROJECT_DIR%"
echo User: %USERNAME%
echo Computer: %COMPUTERNAME%
echo ============================================================

rem Prevent duplicate Task Scheduler/manual launches.
mkdir "%LOCK_DIR%" >nul 2>nul
if errorlevel 1 (
    echo [WARN] Another auto-restore instance appears to be running.
    echo [WARN] Lock: "%LOCK_DIR%"
    exit /b 0
)

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot enter project directory: "%PROJECT_DIR%"
    call :cleanup_lock
    exit /b 10
)

if not exist "package.json" (
    echo [ERROR] package.json was not found in "%CD%".
    call :cleanup_lock
    exit /b 11
)

echo [INFO] Working directory: %CD%

if "%ADMIN_TOKEN%"=="" (
    echo [ERROR] ADMIN_TOKEN is not configured in this Windows account.
    echo [ERROR] Configure it once with: setx ADMIN_TOKEN "your-long-random-token"
    echo [ERROR] Then sign out or restart Windows.
    call :cleanup_lock
    exit /b 12
)

echo [INFO] ADMIN_TOKEN: configured.

where node.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node.exe was not found in PATH.
    call :cleanup_lock
    exit /b 13
)

for /f "delims=" %%V in ('node --version 2^>nul') do echo [INFO] Node: %%V

where pm2.cmd >nul 2>nul
if errorlevel 1 (
    echo [ERROR] pm2.cmd was not found in PATH.
    echo [ERROR] Current PATH: %PATH%
    call :cleanup_lock
    exit /b 14
)

for /f "delims=" %%V in ('call pm2.cmd --version 2^>nul') do echo [INFO] PM2: %%V

echo [INFO] Waiting %BOOT_WAIT_SECONDS%s for Windows/network services to settle...
timeout /t %BOOT_WAIT_SECONDS% /nobreak >nul

rem Start/connect to the PM2 daemon. This is harmless if it is already alive.
echo [INFO] Checking PM2 daemon...
call pm2.cmd ping
if errorlevel 1 (
    echo [WARN] PM2 daemon did not answer yet. Resurrect will retry below.
)

set /a ATTEMPT=0
:resurrect_retry
set /a ATTEMPT+=1
echo.
echo [INFO] PM2 resurrect attempt !ATTEMPT!/%MAX_RETRIES% ...
call pm2.cmd resurrect
set "PM2_RC=!ERRORLEVEL!"

if "!PM2_RC!"=="0" goto resurrect_ok

if !ATTEMPT! GEQ %MAX_RETRIES% (
    echo [ERROR] PM2 resurrect failed after %MAX_RETRIES% attempts. LastExitCode=!PM2_RC!
    echo [ERROR] Make sure the correct process list was saved previously with: pm2 save
    call pm2.cmd list
    call :cleanup_lock
    exit /b 20
)

echo [WARN] PM2 resurrect failed. Retrying in %RETRY_WAIT_SECONDS%s...
timeout /t %RETRY_WAIT_SECONDS% /nobreak >nul
goto resurrect_retry

:resurrect_ok
echo [INFO] PM2 process list restored successfully.

rem Give restored processes a moment to initialize before recording status.
timeout /t 5 /nobreak >nul

echo.
echo [INFO] Current PM2 status:
call pm2.cmd list
if errorlevel 1 (
    echo [WARN] Could not read PM2 process list, although resurrect succeeded.
)

echo.
echo [INFO] PM2 daemon status:
call pm2.cmd ping
if errorlevel 1 (
    echo [WARN] PM2 daemon health check failed after restore.
    call :cleanup_lock
    exit /b 21
)

rem Re-save only the already restored list. This does not add/update code.
echo [INFO] Saving current PM2 process list...
call pm2.cmd save
if errorlevel 1 (
    echo [WARN] pm2 save failed. Services may still be running normally.
)

echo.
echo ============================================================
echo Auto restore completed successfully.
echo Finished: %DATE% %TIME%
echo ============================================================

call :cleanup_lock
exit /b 0

:cleanup_lock
rmdir "%LOCK_DIR%" >nul 2>nul
exit /b 0
