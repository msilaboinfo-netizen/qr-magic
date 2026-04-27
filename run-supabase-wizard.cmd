@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QR-magic Supabase ウィザード
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0render-supabase-wizard.ps1"
echo.
pause
