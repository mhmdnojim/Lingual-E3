#!/usr/bin/env bash
# Takes the newest code from GitHub and restarts the website. On the server, as root:
#     /opt/lingua-books/deploy/update.sh
# (Accounts, books and MP3s are in /var/lib/lingua-books: an update does not touch them.)
set -euo pipefail
cd /opt/lingua-books
if [ -z "${LB_UPDATE_NEW:-}" ]; then
  sudo -u lingua git pull --ff-only
  # (the rest as the new code says it: this file may have changed too)
  LB_UPDATE_NEW=1 exec bash deploy/update.sh "$@"
fi
sudo -u lingua .venv/bin/pip install -q -r web/requirements.txt
# (servers set up before books could be added from Word files: LibreOffice makes them into PDFs)
if ! command -v soffice >/dev/null; then
  echo "Installing LibreOffice, for books added from Word files (once: a few minutes)…"
  apt() { apt-get -o DPkg::Lock::Timeout=1800 "$@"; }
  apt update -q
  apt install -y -q libreoffice-writer-nogui fonts-noto-cjk fonts-crosextra-carlito fonts-crosextra-caladea \
    || apt install -y -q libreoffice-writer fonts-noto-cjk
fi
# (servers set up before these page languages could be chosen: Tesseract reads each with its own pack)
if command -v tesseract >/dev/null; then
  have="$(tesseract --list-langs 2>/dev/null || true)"
  need=""
  for code in rus bul fas urd ind tur fra chi_sim chi_tra spa deu jpn kor ara; do  # (Chinese, Spanish, German, Japanese, Korean, Arabic too)
    echo "$have" | grep -qx "$code" || need="$need tesseract-ocr-$(echo "$code" | tr _ -)"
  done
  if [ -n "$need" ]; then
    echo "Installing the OCR languages:$need (once)…"
    apt-get -o DPkg::Lock::Timeout=1800 update -q
    apt-get -o DPkg::Lock::Timeout=1800 install -y -q $need || echo "Some OCR languages could not be installed: scans in them cannot be read yet."
  fi
fi
# (Whisper on the server: the "This computer (Whisper)" way of Speech recognition; once, a few minutes, ~300 MB)
if [ ! -f web/vendor/models/base.en/model.bin ] || [ ! -f web/vendor/models/base/model.bin ]; then
  echo "Installing Whisper (speech recognition) on the server (once)…"
  {
    sudo -u lingua .venv/bin/pip install -q -r web/transcription-requirements.txt &&
    sudo -u lingua env HF_HOME=/opt/lingua-books/web/_build/huggingface .venv/bin/python -c "
from pathlib import Path
from faster_whisper import download_model
Path('web/vendor/models').mkdir(parents=True, exist_ok=True)
for name in ('base.en', 'base'):
    if not Path(f'web/vendor/models/{name}/model.bin').is_file():
        download_model(name, output_dir=f'web/vendor/models/{name}')
print('Whisper is ready.')"
  } || echo "Whisper could not be installed: use ElevenLabs or OpenAI for Speech recognition."
fi
# (servers set up before it was in setup-server.sh: started again 3 s after a stop, not at once —
# else five quick failures in a row and systemd gives up)
if ! systemctl cat lingua-books | grep -q '^RestartSec='; then
  mkdir -p /etc/systemd/system/lingua-books.service.d
  printf '[Service]\nRestartSec=3\n' > /etc/systemd/system/lingua-books.service.d/restart.conf
  systemctl daemon-reload
fi
systemctl reset-failed lingua-books 2>/dev/null || true
systemctl restart lingua-books
echo "Updated to: $(sudo -u lingua git log -1 --format='%h %s')"
