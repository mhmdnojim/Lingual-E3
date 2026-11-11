@echo off
rem Lingua Books on a student's computer: the books of the website, downloaded here, with the
rem student's website account (web/student.py). Change the address below to your website's.
set SITE=https://dolinguabooks.com
title Lingua Books (student)
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Install it from https://www.python.org/downloads/ and try again.
  pause
  exit /b 1
)
python -c "import edge_tts, imageio_ffmpeg, pdfplumber, PIL, pypinyin" >nul 2>nul
if errorlevel 1 (
  echo Installing the app's tools - only the first time...
  python -m pip install --quiet -r web\requirements.txt
)
python web\server.py --student %SITE%
if errorlevel 1 pause
