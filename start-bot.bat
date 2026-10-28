@echo off
cd /d "%~dp0"

:loop
node --watch src\index.js
echo.
echo O bot parou (codigo de saida %errorlevel%). Reiniciando em 10 segundos...
echo Pressione Ctrl+C para cancelar.
timeout /t 10
goto loop
