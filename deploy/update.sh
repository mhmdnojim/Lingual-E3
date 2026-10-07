#!/usr/bin/env bash
# Takes the newest code from GitHub and restarts the app. On the server, as root:
#     /opt/aef3/deploy/update.sh
# (The book content and your data are not in the repository, so they stay as they are.)
set -euo pipefail
cd /opt/aef3
sudo -u aef git pull --ff-only
systemctl restart aef3
echo "Updated to: $(sudo -u aef git log -1 --format='%h %s')"
