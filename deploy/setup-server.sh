#!/usr/bin/env bash
# Sets up Lingua Books as a public website on a new Ubuntu server (22.04 or 24.04). Once, as root:
#
#     bash setup-server.sh books.example.com git@github.com:YOUR-NAME/YOUR-REPO.git
#
# It installs Python, Tesseract (reads photos of pages) and Caddy (the web server that gets the
# HTTPS certificate by itself), copies the code from GitHub, asks for the admin's e-mail address,
# and starts the app as a service that also starts again after a restart of the server.
# The website starts with an empty library: sign up with the admin's e-mail and add books.
set -euo pipefail
DOMAIN="${1:?Give the domain, e.g. books.example.com}"
REPO="${2:?Give the GitHub address of the repository, e.g. git@github.com:you/lingua-books.git}"
APP=/opt/lingua-books        # the code (from GitHub)
DATA=/var/lib/lingua-books   # accounts, books, MP3s, translations (never touched by updates)

echo "== Programs"
apt-get update -q
apt-get install -y -q python3 python3-venv git curl gpg tesseract-ocr tesseract-ocr-eng \
  debian-keyring debian-archive-keyring apt-transport-https
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

echo "== The app's own user and folders"
id lingua >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin lingua
mkdir -p "$DATA/library" "$DATA/voices" "$DATA/translations"
chown -R lingua:lingua "$DATA"

echo "== The code from GitHub"
if [ ! -d "$APP/.git" ]; then
  if [[ "$REPO" == git@* ]]; then
    # A private repository: the server gets its own key, which you allow (read only) on GitHub.
    if [ ! -f "$DATA/.ssh/id_ed25519" ]; then
      sudo -u lingua mkdir -p "$DATA/.ssh"
      sudo -u lingua ssh-keygen -q -t ed25519 -N '' -C "lingua-books-server" -f "$DATA/.ssh/id_ed25519"
    fi
    sudo -u lingua sh -c "ssh-keyscan -q github.com >> '$DATA/.ssh/known_hosts'"
    echo
    echo "On GitHub, open the repository → Settings → Deploy keys → Add deploy key,"
    echo "give it a name (e.g. server), paste this line and save (leave \"Allow write access\" off):"
    echo
    cat "$DATA/.ssh/id_ed25519.pub"
    echo
    read -rp "Press Enter when the key is added... " _
  fi
  mkdir -p "$APP" && chown lingua:lingua "$APP"
  sudo -u lingua git clone "$REPO" "$APP"
fi

echo "== Python packages"
[ -d "$APP/.venv" ] || sudo -u lingua python3 -m venv "$APP/.venv"
sudo -u lingua "$APP/.venv/bin/pip" install -q --upgrade pip
sudo -u lingua "$APP/.venv/bin/pip" install -q -r "$APP/web/requirements.txt"

echo "== Settings"
if [ ! -f /etc/lingua-books.env ]; then
  read -rp "Your e-mail address (it becomes the admin when you sign up with it): " ADMIN
  read -rp "E-mail address for questions and copyright complaints (shown in the terms) [$ADMIN]: " CONTACT
  umask 077
  cat > /etc/lingua-books.env <<EOF
LB_ADMIN_EMAIL=$ADMIN
LB_CONTACT_EMAIL=${CONTACT:-$ADMIN}
LB_DATA_DIR=$DATA/library
AEF_RECORDINGS_DIR=$DATA/voices
AEF_TRANSLATIONS_DIR=$DATA/translations
EOF
fi

echo "== The app as a service"
cat > /etc/systemd/system/lingua-books.service <<EOF
[Unit]
Description=Lingua Books
After=network-online.target

[Service]
User=lingua
EnvironmentFile=/etc/lingua-books.env
WorkingDirectory=$APP
ExecStart=$APP/.venv/bin/python $APP/web/server.py --public --proxy --no-browser --port 8765
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now lingua-books

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
echo "Done. Open https://$DOMAIN and sign up with your e-mail address (you are the admin)."
