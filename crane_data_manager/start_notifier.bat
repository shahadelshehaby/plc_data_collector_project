@echo off
REM Starts the desktop pop-up notifier by hand (normally started at sign-in).
cd /d "%~dp0"
start "" pythonw notifier.py
