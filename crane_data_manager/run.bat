@echo off
title Crane Data Manager
cd /d "%~dp0"
echo ==============================================
echo   Crane Data Manager  (http://127.0.0.1:5300)
echo ==============================================
sc query CraneDataPlatform 2>nul | find "RUNNING" >nul
if not errorlevel 1 (
    echo The platform runs as a Windows service - opening the page.
    start "" http://127.0.0.1:5300/
    timeout /t 2 >nul
    exit /b 0
)
echo The services are not installed: starting in test mode (two windows).
echo For the real installation use install_service.bat (as administrator).
echo.
echo Checking Python packages (first run only, may take a minute)...
python -m pip install -q -r requirements.txt
if not exist "influx_token.txt" if not defined INFLUX_TOKEN (
    echo influx_token.txt is missing. Create it with the InfluxDB token on one line.
    pause & exit /b 1
)
start "Crane Data Manager - Collector (keep open)" python collector_service.py
timeout /t 2 >nul
echo Starting the platform - your browser opens automatically.
echo Closing THIS window stops the platform page; closing the other window stops collecting.
python app.py --open
pause
