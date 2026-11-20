@echo off
chcp 65001 >nul
title EPG IPTV Yoneticisi Turkce ve Almanca
echo ========================================================
echo   IPTV EPG Yoneticisi Turkce ve Almanca Baslatiliyor...
echo ========================================================
echo Arayuz http://localhost:3000 adresinde calisacaktir.
echo Lutfen bu pencereyi kapatmayin.
echo.
node -r @swc-node/register server.ts
pause
