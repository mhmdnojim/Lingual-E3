@echo off
title Set up speech recognition (the Transcribe button)
cd /d "%~dp0"
rem Installs English and multilingual speech recognition into web\vendor (internet required).
if not exist "web\_build\transcription-temp" mkdir "web\_build\transcription-temp"
set "TEMP=%~dp0web\_build\transcription-temp"
set "TMP=%TEMP%"
set "HF_HOME=%~dp0web\_build\huggingface"
python -c "import sys; sys.path.insert(0, 'web/vendor/python'); import faster_whisper" 2>nul
if errorlevel 1 (
  python -m pip install --no-cache-dir --upgrade --target web\vendor\python -r web\transcription-requirements.txt
  if errorlevel 1 goto failed
)
python -c "import sys; sys.path.insert(0, 'web/vendor/python'); from faster_whisper import download_model; from pathlib import Path; Path('web/vendor/models').mkdir(parents=True, exist_ok=True); p=Path('web/vendor/models/base.en/model.bin'); download_model('base.en', output_dir='web/vendor/models/base.en') if not p.is_file() else None; p=Path('web/vendor/models/base/model.bin'); download_model('base', output_dir='web/vendor/models/base') if not p.is_file() else None; print('English and multilingual speech recognition are ready. Restart Lingua Books.')"
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Setup failed. Check the messages above, then try again.
pause
exit /b 1
