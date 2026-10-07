@echo off
title American English File 3 - for phones on the home Wi-Fi
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Install it from https://www.python.org/downloads/ and try again.
  pause
  exit /b 1
)
rem The natural-voice MP3s ("My audio") need these two packages. Installed once, if missing.
python -c "import edge_tts, imageio_ffmpeg" >nul 2>nul
if errorlevel 1 (
  echo Installing the voice tools - only the first time...
  python -m pip install --quiet edge-tts imageio-ffmpeg
)
rem Like "Start American English File.bat", but phones and tablets on the same Wi-Fi can open it
rem too. This window shows the address to type on the phone and the PIN to log in.
python web\server.py --lan
if errorlevel 1 pause
