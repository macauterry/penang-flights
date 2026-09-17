@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 인천-페낭 최저가 앱
node tools\serve.mjs
pause
