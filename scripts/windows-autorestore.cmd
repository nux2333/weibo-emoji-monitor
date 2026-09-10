@echo off
setlocal

cd /d "%~dp0.."

echo ==============================================
echo Weibo Monitor - Windows Auto Restore
echo Working directory: %CD%
echo ==============================================

if "%ADMIN_TOKEN%"=="" (
  echo [ERROR] ADMIN_TOKEN is not configured in Windows environment.
  echo Please configure it once with:
  echo   setx ADMIN_TOKEN "your-long-random-token"
  echo Then sign out/restart Windows before using auto restore.
  exit /b 1
)

where pm2.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pm2.cmd was not found in PATH.
  exit /b 1
)

echo [INFO] Restoring saved PM2 process list...
call pm2.cmd resurrect

if errorlevel 1 (
  echo [WARN] PM2 resurrect failed.
  echo [WARN] Run "pm2.cmd save" once while the correct processes are online.
  exit /b 1
)

echo [INFO] PM2 processes restored.
call pm2.cmd list

echo.
echo [INFO] Starting Cloudflare Tunnel...

where cloudflared.exe >nul 2>nul
if errorlevel 1 (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo [WARN] cloudflared was not found in PATH.
    echo [WARN] PM2 processes are already restored, but the public tunnel was not started.
    goto :done
  )
)

REM
REM Use Quick Tunnel because this project exposes the local SuperLike page
REM directly with: cloudflared tunnel --url http://localhost:3000
REM "start" keeps this restore script from being blocked by cloudflared.
REM
start "Weibo Cloudflare Tunnel" /min cloudflared tunnel --url http://localhost:3000

echo [INFO] Cloudflare Tunnel start command sent.
echo [INFO] Public route points to http://localhost:3000

:done
echo ==============================================
echo Auto restore completed.
echo ==============================================

endlocal
exit /b 0
