@echo off
cd /d "%~dp0"
title Lucira Deals Dashboard - server
start "Lucira Deals Dashboard - server" cmd /k "npm start"
timeout /t 3 /nobreak >nul
start "" http://localhost:3000
