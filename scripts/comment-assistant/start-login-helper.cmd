@echo off
setlocal
cd /d "%~dp0\..\.."
title Comment Assistant Login Helper
echo Starting Comment Assistant Desktop Login Helper...
npm.cmd run comment-login-helper
pause
