@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QR-magic Render へ反映（メモ帳用）
echo.
if not exist "%~dp0secrets-for-render.txt" (
  echo 【エラー】 secrets-for-render.txt がありません。
  echo.
  echo 1 メモ帳で secrets-for-render.example.txt を開く
  echo 2 別名保存で「secrets-for-render.txt」と保存（qr-magic フォルダの中）
  echo 3 = の右に鍵を貼って保存
  echo.
  pause
  exit /b 1
)
node "%~dp0scripts\set-render-supabase-env.js"
echo.
pause
