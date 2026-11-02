@echo off
title Set up automatic speaker detection
cd /d "%~dp0"
set "MODEL=web\vendor\models\speaker-diarization-community-1"
if not exist "%MODEL%\config.yaml" goto model_missing
echo Automatic speaker detection is already set up.
pause
exit /b 0

:model_missing
echo This downloads the local speaker detection program and model.
echo First, accept the model conditions at:
echo https://huggingface.co/pyannote/speaker-diarization-community-1
echo Then create a read token at https://huggingface.co/settings/tokens
echo Set it in this window before running this file, for example:
echo   set HF_TOKEN=your_read_token
echo Do not share your token with anyone.
if not defined HF_TOKEN goto failed_token

if not exist "web\vendor\diarization\Scripts\python.exe" (
  python -m venv web\vendor\diarization
  if errorlevel 1 goto failed
)
web\vendor\diarization\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto failed
web\vendor\diarization\Scripts\python.exe -m pip install -r web\diarization-requirements.txt
if errorlevel 1 goto failed
web\vendor\diarization\Scripts\python.exe -c "import os; from huggingface_hub import snapshot_download; snapshot_download('pyannote/speaker-diarization-community-1', token=os.environ['HF_TOKEN'], local_dir='web/vendor/models/speaker-diarization-community-1'); print('Speaker detection is ready. Restart Lingua Books.')"
if errorlevel 1 goto failed
pause
exit /b 0

:failed_token
echo Set HF_TOKEN after accepting the model conditions, then run this file again.
goto failed
:failed
echo Setup failed. Check the messages above, then try again.
pause
exit /b 1
