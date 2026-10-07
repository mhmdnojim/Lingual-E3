#!/usr/bin/env bash
# Takes the newest code from GitHub and restarts the website. On the server, as root:
#     /opt/lingua-books/deploy/update.sh
# (Accounts, books and MP3s are in /var/lib/lingua-books: an update does not touch them.)
set -euo pipefail
cd /opt/lingua-books
sudo -u lingua git pull --ff-only
sudo -u lingua .venv/bin/pip install -q -r web/requirements.txt
systemctl restart lingua-books
echo "Updated to: $(sudo -u lingua git log -1 --format='%h %s')"
