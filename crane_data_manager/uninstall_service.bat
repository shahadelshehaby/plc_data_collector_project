@echo off
REM Stops and removes the Crane Data Manager services and the notifier task.
REM Your settings, crane register, versions and history in data\ are kept.
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 ( echo Please right-click and choose "Run as administrator". & pause & exit /b 1 )
echo This STOPS DATA COLLECTION for all cranes.
choice /c YN /m "Remove the Crane Data Manager services"
if errorlevel 2 exit /b 0
for %%S in (CraneDataCollector CraneDataPlatform) do (
    "%~dp0nssm.exe" stop %%S >nul 2>&1
    "%~dp0nssm.exe" remove %%S confirm
)
schtasks /delete /tn "Crane Data Manager - Notifier" /f >nul 2>&1
echo Removed. Data in the data\ folder is kept.
pause
