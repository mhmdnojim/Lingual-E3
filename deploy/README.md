# Putting Lingua Books online (a public website)

The website runs on a small server of your own. GitHub keeps the **code**; the server gets it
from there. Accounts, books and MP3s live only on the server (back them up with `backup.sh`).
The books of the American English File disc stay on your computer: the website never shows them.

```
your computer ── git push ──▶ GitHub ── update.sh ──▶ server  ──▶  https://your-domain
                                                       (accounts, books, MP3s)
```

## What you need

- A **VPS** (virtual server), not "shared hosting": the app needs its Python program running all
  the time. Ubuntu 22.04 or 24.04, 2 GB memory, 40 GB disk or more (books with pictures take
  room). For example Hetzner, DigitalOcean, Contabo, Vultr (about 5–10 US$ a month).
- A **domain** (or a subdomain such as `books.your-domain.com`). In the domain's DNS settings,
  add an **A record** that points to the server's IP address.

## With dolingual.com

`dolingual.com` is now the Dolingual flashcards site, made and hosted with **Lovable**. Lovable
only serves finished pages; it cannot run this app's Python program (accounts, PDFs, photos,
translations, MP3s). So the app goes on its own server, under a **subdomain**, and the Dolingual
site stays as it is:

```
https://dolingual.com        → Lovable (as now, nothing changes)
https://books.dolingual.com  → your VPS (this app)
```

The domain's DNS is at **Name.com**: My Domains → dolingual.com → **Manage DNS Records** →
add a record: Type **A**, Host **books**, Answer **the VPS's IP address**, TTL 300.
Do not change the records that are already there (they keep the Dolingual site working).
Then set up the server (step 2) with `books.dolingual.com`. A link to it can be added in the
Dolingual site (in Lovable).

## With dolinguabooks.com (Hostinger)

The domain `dolinguabooks.com` and the VPS (**KVM 4**) are both at Hostinger. Buy no web hosting
plan (Single, Premium, Unlimited, Cloud): those are shared hosting and cannot run the app.

1. The VPS's operating system: hPanel → **VPS** → Manage → **OS & Panel** → **Plain OS** →
   **Ubuntu 24.04** (not a template with an app or a control panel).
2. Its address: hPanel → **VPS** → Manage → Overview → **IPv4** (e.g. `82.25.x.x`).
3. The domain to it: hPanel → **Domains** → dolinguabooks.com → **DNS / Nameservers** → the
   **A** record with Name **@**: Points to **the VPS's IPv4** (instead of Hostinger's default
   page). Keep the **CNAME** `www` → `dolinguabooks.com`. It works within minutes to an hour.
4. Step 2 below with `dolinguabooks.com` (www.dolinguabooks.com then leads there too).

## 1. Code to GitHub

Already done: https://github.com/mhmdnojim/Lingual-E3 (the old address,
…/American-English-File-2e-Level-3, still leads there). Later changes:

```
git add -A
git commit -m "What changed"
git push
```

## 2. Set up the server (once)

Log in to the server (`ssh root@SERVER-IP`) and run:

```
curl -O https://raw.githubusercontent.com/mhmdnojim/Lingual-E3/main/deploy/setup-server.sh
bash setup-server.sh books.dolingual.com https://github.com/mhmdnojim/Lingual-E3.git
```

(For a **private** repository use the `git@github.com:…` address instead: the script then shows
a key to add on GitHub under Settings → Deploy keys.)

On a fresh setup, the script asks for **your admin e-mail address** (default:
`mhmd.nojim@gmail.com`), creates an owner setup code, and enables subscriptions. Sign up with that
e-mail and enter the owner setup code printed at the end of setup. This proves you control the
server before the account gets the *Admin* role. Keep the setup code private.

Open `https://books.dolingual.com`, **Sign up** with that e-mail, and add the first books.

## Updates

After `git push`:

```
ssh root@SERVER-IP /opt/lingua-books/deploy/update.sh
```

## Subscription access codes

On a fresh server setup, `LB_REQUIRE_SUBSCRIPTION=1` is enabled. Users create an account, then
redeem a one-use code. The code starts its subscription when redeemed; the admin chooses its
length, the books it covers, and how long the unused code remains valid. In **Library → Admin**,
generate a code and QR link, cancel unused codes, or revoke a user's active subscription. The
QR opens the sign-in and redemption page. `LB_PUBLIC_URL` must be the site's HTTPS address so the
QR works on phones.

The admin account uses `LB_ADMIN_EMAIL` and `LB_ADMIN_SETUP_TOKEN`. To change the owner on an
existing server, update those values in `/etc/lingua-books.env`, restart the service, then claim
the configured e-mail with the owner setup code. To turn subscriptions off, set
`LB_REQUIRE_SUBSCRIPTION=0` and restart the service.

Only serve books you are allowed to distribute. Add them to the server's library and share them
there; do not expose the original `.shared` or `web/data` folders as static files. The server
checks access for each book API and page image request. A user who has already received or saved
book content can keep a copy of it; subscriptions control future server access.

## Good to know

### Old-app imports

The library now has **Import old app**: upload a ZIP or choose a folder, inspect supported
content, select extraction settings, approve sample pages, then convert with six numbered
progress steps. It runs in the Python server without VS Code/Codex or an AI key. See
`web/README.md` for the supported formats and limitations. This imports books into the existing
reader; it does not automatically rewrite an arbitrary application's code or Flash activities.

- On the website, an account is required. Import jobs, previews, reports and exports belong
  to that account (admins may access them); new books start private.
- Source uploads, job checkpoints and exports live in `$LB_DATA_DIR/migrations/<job-id>/`;
  converted books live in `$LB_DATA_DIR/books/<book-id>/`. Both are included when backing up
  the entire data directory. Closing the importer does not delete these files. For storage
  cleanup, **Remove import files** (after confirmation) deletes the job's source,
  previews, export and unfinished books, while keeping completed books. Otherwise allow space for
  the upload, extracted source, converted pages and export ZIP. Retained source/export storage
  is separate from the ordinary per-account book quota; monitor disk usage on public hosts.
- Defaults: **512 MiB per uploaded file/ZIP**, **8 GiB total/expanded source**, **250,000 files**,
  **2,000 selected pages** per job, up to **10 unfinished jobs** per account. Configure
  `LB_MIGRATION_UPLOAD_MB`, `LB_MIGRATION_TOTAL_MB`, `LB_MIGRATION_FILES`, and
  `LB_MIGRATION_PAGES` in the server environment, then restart the service. Use smaller
  limits on small/public servers. A folder upload sends files individually; ZIP is usually faster.
- Processing is serialized for imports to limit OCR memory use. Running jobs interrupted by
  a server restart can be retried from the importer; completed pages are reused after validation.
- Install the OCR languages the books need on the **server**. English PDFs with embedded
  text do not need OCR; Chinese scans need the corresponding Chinese and English OCR packs.
- If a reverse proxy rejects a large upload, its request-size/time limits may need adjustment.
  Do not expose the data directory as a static website: artifacts/media are served only through
  permission-checked routes. Uploaded EXE, scripts and HTML remain inert and are never served.

### General notes

- Where things are on the server: the code in `/opt/lingua-books`, everything people add in
  `/var/lib/lingua-books`, the settings in `/etc/lingua-books.env` (after a change:
  `systemctl restart lingua-books`).
- **Backups**: `/opt/lingua-books/deploy/backup.sh` makes one file with everything; copy it to
  your computer now and then (`scp root@SERVER-IP:/root/lingua-books-*.tar.gz .`).
- **Limits** for each account (in `web/library.py`, `LIMITS`): 100 books, 600 MB, PDFs up to
  60 MB and 300 pages, 200 photos per book, 30 new books and 40 MP3s a day. Admins have no limits
  of books and space, and their PDFs can be up to 500 MB (`ADMIN_PDF_MB`: a whole textbook).
- **Reports**: a book reported by three different people is hidden at once until an admin looks
  at it (Admin tab). Answer copyright complaints quickly: hide or delete the book.
- Word files of books are made into PDFs with **LibreOffice** on the server (setup-server.sh installs
  it with Chinese fonts; on a server set up before, update.sh installs it once);
- Photos of pages are read with **Tesseract** on the server; translations use Google's free
  translator and MP3s Microsoft's online voices (see the terms page).
