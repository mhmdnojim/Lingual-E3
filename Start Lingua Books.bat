@echo off
title Lingua Books
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Install it from https://www.python.org/downloads/ and try again.
  pause
  exit /b 1
)
rem The server's packages (natural voices, MP3s, PDF books: web\requirements.txt). Installed once, if missing.
python -c "import edge_tts, imageio_ffmpeg, pdfplumber, PIL" >nul 2>nul
if errorlevel 1 (
  echo Installing the app's tools - only the first time...
  python -m pip install --quiet -r web\requirements.txt
)
python web\server.py
if errorlevel 1 pause
