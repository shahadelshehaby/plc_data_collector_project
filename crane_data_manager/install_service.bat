@echo off
REM ======================================================================
REM  Crane Data Manager - install as Windows services (run as administrator)
REM
REM   CraneDataCollector  collector_service.py  UDP -> InfluxDB, always on
REM   CraneDataPlatform   app.py                web page http://127.0.0.1:5300
REM   + "Crane Data Manager - Notifier" task    desktop pop-ups at sign-in
REM
REM  Both services start at boot (before anyone signs in), keep running when
REM  you sign out, and are restarted automatically if they ever stop.
REM ======================================================================
setlocal EnableExtensions
cd /d "%~dp0"
set "COL=CraneDataCollector"
set "PLA=CraneDataPlatform"
set "TASK=Crane Data Manager - Notifier"

net session >nul 2>&1
if errorlevel 1 (
    echo Please right-click install_service.bat and choose "Run as administrator".
    pause & exit /b 1
)

set "NSSM=%~dp0nssm.exe"
if not exist "%NSSM%" (
    echo nssm.exe was not found in this folder.
    echo Copy nssm.exe from your terminal2_collector folder, or download it from
    echo https://nssm.cc/download and copy win64\nssm.exe into: %~dp0
    pause & exit /b 1
)

for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)"') do set "PY=%%P"
if not defined PY (
    echo Python was not found. Install Python 3.10+ and tick "Add python.exe to PATH".
    pause & exit /b 1
)
set "PYW=%PY:python.exe=pythonw.exe%"
if not exist "%PYW%" set "PYW=%PY%"
echo Using Python: %PY%

echo Installing / checking Python packages ...
"%PY%" -m pip install -q -r requirements.txt
if errorlevel 1 ( echo Package installation failed. & pause & exit /b 1 )

if not exist "influx_token.txt" if not defined INFLUX_TOKEN (
    echo.
    echo influx_token.txt is missing. Create it in this folder with the InfluxDB token on one line.
    pause & exit /b 1
)

echo.
echo The new collector listens on the ports of every crane registered in the platform.
echo An old collector that still holds one of those ports makes that crane show PORT BUSY
echo until the old one is stopped. Move one terminal at a time.
sc query CraneCollectorT2 >nul 2>&1
if not errorlevel 1 (
    choice /c YN /m "Stop and disable the old service CraneCollectorT2 (Terminal 2 launcher) now"
    if not errorlevel 2 (
        sc stop CraneCollectorT2 >nul 2>&1
        sc config CraneCollectorT2 start= disabled >nul 2>&1
        echo Old CraneCollectorT2 stopped and disabled ^(not removed - you can re-enable it^).
    )
)

for %%S in (%COL% %PLA%) do (
    "%NSSM%" stop %%S >nul 2>&1
    "%NSSM%" remove %%S confirm >nul 2>&1
)
if not exist logs mkdir logs

REM -- collector service --
"%NSSM%" install %COL% "%PY%" collector_service.py
"%NSSM%" set %COL% AppDirectory "%~dp0."
"%NSSM%" set %COL% DisplayName "Crane Data Manager - Collector"
"%NSSM%" set %COL% Description "Crane PLC UDP packets -> InfluxDB (all cranes, all terminals)"
"%NSSM%" set %COL% Start SERVICE_AUTO_START
"%NSSM%" set %COL% AppExit Default Restart
"%NSSM%" set %COL% AppRestartDelay 3000
"%NSSM%" set %COL% AppThrottle 1500
"%NSSM%" set %COL% AppStopMethodConsole 10000
"%NSSM%" set %COL% AppKillProcessTree 1
"%NSSM%" set %COL% AppStdout "%~dp0logs\collector_service_output.txt"
"%NSSM%" set %COL% AppStderr "%~dp0logs\collector_service_output.txt"
"%NSSM%" set %COL% AppRotateFiles 1
"%NSSM%" set %COL% AppRotateBytes 5000000
sc failure %COL% reset= 86400 actions= restart/5000/restart/5000/restart/10000 >nul

REM -- platform service --
"%NSSM%" install %PLA% "%PY%" app.py
"%NSSM%" set %PLA% AppDirectory "%~dp0."
"%NSSM%" set %PLA% DisplayName "Crane Data Manager - Platform"
"%NSSM%" set %PLA% Description "Crane Data Manager web page on http://127.0.0.1:5300 (also watches the collector)"
"%NSSM%" set %PLA% Start SERVICE_AUTO_START
"%NSSM%" set %PLA% AppExit Default Restart
"%NSSM%" set %PLA% AppRestartDelay 5000
"%NSSM%" set %PLA% AppStdout "%~dp0logs\platform_service_output.txt"
"%NSSM%" set %PLA% AppStderr "%~dp0logs\platform_service_output.txt"
"%NSSM%" set %PLA% AppRotateFiles 1
"%NSSM%" set %PLA% AppRotateBytes 5000000
sc failure %PLA% reset= 86400 actions= restart/5000/restart/5000/restart/10000 >nul

"%NSSM%" start %COL%
"%NSSM%" start %PLA%

REM -- desktop notifier: starts when this Windows user signs in --
schtasks /create /tn "%TASK%" /tr "\"%PYW%\" \"%~dp0notifier.py\"" /sc onlogon /rl limited /f >nul
schtasks /run /tn "%TASK%" >nul 2>&1

echo.
echo Installed and started:
echo    %COL%  - collector (always on)
echo    %PLA%  - platform  http://127.0.0.1:5300/
echo    "%TASK%" - desktop pop-ups for new alarms
timeout /t 3 >nul
start "" http://127.0.0.1:5300/
pause
