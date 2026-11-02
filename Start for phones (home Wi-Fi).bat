@echo off
title Lingua Books - for phones on the home Wi-Fi
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Install it from https://www.python.org/downloads/ and try again.
  pause
  exit /b 1
)
rem The server's packages (natural voices, MP3s, PDF books, pinyin: web\requirements.txt). Installed once, if missing.
python -c "import edge_tts, imageio_ffmpeg, pdfplumber, PIL, pypinyin" >nul 2>nul
if errorlevel 1 (
  echo Installing the app's tools - only the first time...
  python -m pip install --quiet -r web\requirements.txt
)
rem Like "Start Lingua Books.bat", but phones and tablets on the same Wi-Fi can open it
rem too. This window shows the address to type on the phone and the PIN to log in.
python web\server.py --lan
if errorlevel 1 pause
