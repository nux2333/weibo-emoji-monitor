@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."
title Comment Assistant Login Helper

rem Keep the desktop login helper alive in the interactive Windows session.
rem This script is intended to be started when the Windows user logs in,
rem NOT by PM2/Session 0, because login windows need an interactive desktop.

:restart
echo [%date% %time%] Starting Comment Assistant Desktop Login Helper...
node scripts\comment-assistant\login-helper.js
set "RC=%ERRORLEVEL%"
echo [%date% %time%] Login Helper exited. ExitCode=%RC%. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto restart
