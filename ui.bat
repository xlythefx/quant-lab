@echo off
REM One-click launcher for the QuantLab GUI control panel (ui.py).
REM Double-click this (or pin it to the taskbar). Uses pythonw so no console.
cd /d "%~dp0"
start "" pythonw ui.py
