@echo off
title CarePoint Hospital Backend
cd /d "%~dp0"
echo ==============================================
echo Starting CarePoint Hospital Backend Server...
echo ==============================================
node backend/server.js
pause

