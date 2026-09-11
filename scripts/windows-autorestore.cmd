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
set "MAX_RETRIES=5"
set "RETRY_WAIT_SECONDS=15"
set "BOOT_WAIT_SECONDS=30"

rem Task Scheduler can run before a normal interactive user session exists.
rem Pin PM2 to admin's real PM2 home so scheduled and interactive PM2 use
rem exactly the same daemon/dump.pm2/process list.
set "USERPROFILE=C:\Users\admin"
set "HOME=C:\Users\admin"
set "PM2_HOME=C:\Users\admin\.pm2"
set "NODE_DIR=C:\Program Files\nodejs"
set "NPM_GLOBAL_DIR=C:\Users\admin\AppData\Roaming\npm"
set "PM2_CMD=%NPM_GLOBAL_DIR%\pm2.cmd"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "PATH=%NODE_DIR%;%NPM_GLOBAL_DIR%;%PATH%"

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
echo USERPROFILE: %USERPROFILE%
echo PM2_HOME: %PM2_HOME%
echo PM2_CMD: %PM2_CMD%
echo ============================================================

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot enter project directory: "%PROJECT_DIR%"
    exit /b 10
)

if not exist "package.json" (
    echo [ERROR] package.json was not found in "%CD%".
    exit /b 11
)

echo [INFO] Working directory: %CD%

if "%ADMIN_TOKEN%"=="" (
    echo [ERROR] ADMIN_TOKEN is not configured in this Windows account.
    echo [ERROR] Configure it once with: setx ADMIN_TOKEN "your-long-random-token"
    echo [ERROR] Then sign out or restart Windows.
    exit /b 12
)

echo [INFO] ADMIN_TOKEN: configured.

if not exist "%NODE_EXE%" (
    echo [ERROR] Node was not found at: "%NODE_EXE%"
    exit /b 13
)

for /f "delims=" %%V in ('"%NODE_EXE%" --version 2^>nul') do echo [INFO] Node: %%V

if not exist "%PM2_CMD%" (
    echo [ERROR] PM2 was not found at: "%PM2_CMD%"
    exit /b 14
)

if not exist "%PM2_HOME%\dump.pm2" (
    echo [ERROR] PM2 dump file was not found: "%PM2_HOME%\dump.pm2"
    echo [ERROR] Start the correct PM2 processes interactively and run: pm2.cmd save
    exit /b 15
)

if not exist "%PROJECT_DIR%\ecosystem.server.config.js" (
    echo [ERROR] Server ecosystem file was not found: "%PROJECT_DIR%\ecosystem.server.config.js"
    exit /b 16
)

if not exist "%PROJECT_DIR%\ecosystem.batches.config.js" (
    echo [ERROR] Batch ecosystem file was not found: "%PROJECT_DIR%\ecosystem.batches.config.js"
    exit /b 17
)

for %%F in ("%PM2_HOME%\dump.pm2") do echo [INFO] PM2 dump: %%~fF ^(%%~zF bytes^)

for /f "delims=" %%V in ('call "%PM2_CMD%" --version 2^>nul') do echo [INFO] PM2: %%V

echo [INFO] Waiting %BOOT_WAIT_SECONDS%s for Windows/network/services to settle...
timeout /t %BOOT_WAIT_SECONDS% /nobreak >nul

set /a ATTEMPT=0
:resurrect_retry
set /a ATTEMPT+=1
echo.
echo [INFO] PM2 resurrect attempt !ATTEMPT!/%MAX_RETRIES% ...
call "%PM2_CMD%" resurrect
set "PM2_RC=!ERRORLEVEL!"

if "!PM2_RC!"=="0" goto resurrect_ok

if !ATTEMPT! GEQ %MAX_RETRIES% (
    echo [ERROR] PM2 resurrect failed after %MAX_RETRIES% attempts. LastExitCode=!PM2_RC!
    call "%PM2_CMD%" list
    exit /b 20
)

echo [WARN] PM2 resurrect failed. Retrying in %RETRY_WAIT_SECONDS%s...
timeout /t %RETRY_WAIT_SECONDS% /nobreak >nul
goto resurrect_retry

:resurrect_ok
echo [INFO] PM2 resurrect command succeeded.

rem ============================================================
rem Server and background workers use different ecosystem files.
rem Mode1/Mode2/Mode3/JYZ remain manual and are intentionally excluded.
rem ============================================================
echo.
echo [INFO] Ensuring weibo-server is online from ecosystem.server.config.js ...
call "%PM2_CMD%" start "%PROJECT_DIR%\ecosystem.server.config.js" --only "weibo-server" --update-env
if errorlevel 1 (
    echo [ERROR] Failed to start weibo-server from server ecosystem.
    call "%PM2_CMD%" list
    exit /b 23
)

echo.
echo [INFO] Force-starting required batch apps from ecosystem.batches.config.js ...
set "BOOT_APPS=weibo-proxy-pool scan-fresh-latest scan-fresh-hot scan-fresh-superlike scan-fresh-yishanshui scan-fresh-qa scan-history superlike-mode4"
set "BOOT_START_FAILED=0"

for %%A in (%BOOT_APPS%) do (
    echo [INFO] Ensuring %%A is online ...
    call "%PM2_CMD%" start "%PROJECT_DIR%\ecosystem.batches.config.js" --only "%%A" --update-env
    if errorlevel 1 (
        echo [ERROR] Failed to start %%A from batch ecosystem.
        set "BOOT_START_FAILED=1"
    )
)

if "!BOOT_START_FAILED!"=="1" (
    echo [ERROR] One or more required boot apps failed to start.
    call "%PM2_CMD%" list
    exit /b 24
)

timeout /t 8 /nobreak >nul

echo.
echo [INFO] Current PM2 status:
call "%PM2_CMD%" list
set "LIST_RC=!ERRORLEVEL!"
if not "!LIST_RC!"=="0" (
    echo [ERROR] Could not read PM2 process list after restore. ExitCode=!LIST_RC!
    exit /b 21
)

echo.
echo [INFO] PM2 daemon status:
call "%PM2_CMD%" ping
if errorlevel 1 (
    echo [ERROR] PM2 daemon health check failed after restore.
    exit /b 22
)

rem IMPORTANT: Do not automatically pm2 save here.
rem If an abnormal/partial restore occurs, auto-save could overwrite a good
rem dump.pm2 with a broken or empty process list. Save only after intentional
rem process configuration changes.

echo.
echo ============================================================
echo Auto restore completed successfully.
echo Finished: %DATE% %TIME%
echo ============================================================
exit /b 0
