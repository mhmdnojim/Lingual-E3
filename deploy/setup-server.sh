#!/usr/bin/env bash
# Sets up American English File 3 on a new Ubuntu server (22.04 or 24.04). Run it once, as root:
#
#     bash setup-server.sh aef.example.com git@github.com:YOUR-NAME/YOUR-REPO.git
#
# It installs Python and Caddy (the web server that gets the HTTPS certificate by itself),
# copies the app's code from GitHub, asks for the website's password, and starts the app as a
# service that also starts again after a restart of the server. The book content and your own
# data are copied from your computer afterwards (deploy/upload-content.ps1).
set -euo pipefail
DOMAIN="${1:?Give the domain, e.g. aef.example.com}"
REPO="${2:?Give the GitHub address of the repository, e.g. git@github.com:you/aef3.git}"
APP=/opt/aef3          # the code (from GitHub) and the book content
DATA=/var/lib/aef3     # your corrections, MP3s and translations (never touched by updates)

echo "== Programs"
apt-get update -q
apt-get install -y -q python3 python3-venv git curl gpg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

echo "== The app's own user and folders"
id aef >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin aef
mkdir -p "$DATA/edits" "$DATA/recordings" "$DATA/translations"
chown -R aef:aef "$DATA"

echo "== The code from GitHub"
if [ ! -d "$APP/.git" ]; then
  # A private repository: the server gets its own key, which you allow (read only) on GitHub.
  if [ ! -f "$DATA/.ssh/id_ed25519" ]; then
    sudo -u aef mkdir -p "$DATA/.ssh"
    sudo -u aef ssh-keygen -q -t ed25519 -N '' -C "aef3-server" -f "$DATA/.ssh/id_ed25519"
  fi
  sudo -u aef sh -c "ssh-keyscan -q github.com >> '$DATA/.ssh/known_hosts'"
  echo
  echo "On GitHub, open the repository → Settings → Deploy keys → Add deploy key,"
  echo "give it a name (e.g. server), paste this line and save (leave \"Allow write access\" off):"
  echo
  cat "$DATA/.ssh/id_ed25519.pub"
  echo
  read -rp "Press Enter when the key is added... " _
  mkdir -p "$APP" && chown aef:aef "$APP"
  sudo -u aef git clone "$REPO" "$APP"
fi

echo "== Python packages for the natural voices (My audio)"
[ -d "$APP/.venv" ] || sudo -u aef python3 -m venv "$APP/.venv"
sudo -u aef "$APP/.venv/bin/pip" install -q --upgrade pip edge-tts imageio-ffmpeg

echo "== The website's password"
if [ ! -f /etc/aef3.env ]; then
  read -rsp "Choose the password to log in to the website: " PW; echo
  umask 077
  cat > /etc/aef3.env <<EOF
AEF_PASSWORD=$PW
AEF_EDITS_DIR=$DATA/edits
AEF_RECORDINGS_DIR=$DATA/recordings
AEF_TRANSLATIONS_DIR=$DATA/translations
EOF
fi

echo "== The app as a service"
cat > /etc/systemd/system/aef3.service <<EOF
[Unit]
Description=American English File 3
After=network-online.target

[Service]
User=aef
EnvironmentFile=/etc/aef3.env
WorkingDirectory=$APP
ExecStart=$APP/.venv/bin/python $APP/web/server.py --proxy --no-browser --port 8765
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now aef3

echo "== HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8765
}
EOF
systemctl reload caddy || systemctl restart caddy
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80,443/tcp; fi

echo
echo "Done. Now copy the book content from your computer: deploy\\upload-content.ps1"
echo "Then open https://$DOMAIN"
