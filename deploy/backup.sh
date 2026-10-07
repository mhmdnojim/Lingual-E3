#!/usr/bin/env bash
# A copy of everything people added (accounts, books, MP3s, translations) in one file.
# On the server, as root:   /opt/lingua-books/deploy/backup.sh
# Then copy it to your computer:   scp root@SERVER-IP:/root/lingua-books-*.tar.gz .
set -euo pipefail
FILE="/root/lingua-books-$(date +%Y-%m-%d).tar.gz"
# The database is copied safely while the site runs (sqlite3 .backup), then everything is packed.
TMP=$(mktemp -d)
python3 -c "import sqlite3; s=sqlite3.connect('/var/lib/lingua-books/library/library.db'); d=sqlite3.connect('$TMP/library.db'); s.backup(d)"
tar -czf "$FILE" --exclude=./library/library.db --exclude='./library/library.db-*' -C /var/lib/lingua-books . \
  --transform 's,^library\.db$,./library/library.db,' -C "$TMP" library.db
rm -rf "$TMP"
echo "Saved: $FILE ($(du -h "$FILE" | cut -f1))"
