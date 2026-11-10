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
