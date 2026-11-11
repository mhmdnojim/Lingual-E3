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

### The Admin page

**Users** (above). **Features**: in a user's page, or **Features for everyone…** above the list
(tick users first to switch features for the chosen ones): Add books, My audio, Translation,
Sentence breakdown, New words and flashcards, Correction mode, Download the PDF, Offline use —
on for everyone unless switched off. **Paid AI** (scripts of audio and video by ElevenLabs,
pictures made by AI, page layouts by AI) is off until an admin gives an account an amount (minutes
of scripts, a number of pictures or pages), with or without an end date; the server counts every
use and stops at zero.

**Plans and payments**: a plan is a name, a price as it is shown, the days it gives, all shared
books or chosen ones, how long the app may stay offline with it (3 days unless changed), and up to
two pictures of your payment QR codes (WeChat, Alipay, a bank …). There is no online payment: a
user pays you, presses **I paid** (with a note and a screenshot if they like), and the request
appears here — **Approve** (the plan's days are given; the amount you type is your own note of
what you received, not a proof) or **Refuse** (with a word for the user). A new account gets a
**free trial** (3 days of all shared books; set 0 for none). Access codes can be of a plan.

**Statistics**: today, this week, this month, this year or two dates; everyone or one account:
accounts active, time active, sign-ups, who has a plan, payments approved and the money recorded,
the paid AI used and about what it cost you. The app keeps a record of use for this (the terms
page says so): per account and day, the pages opened, the minutes active and how many times each
feature was used — never what was read; kept a year.

**API** (the owner only): every online service and its key — ElevenLabs (a main and a backup key,
used when the main one is refused or out of credits), OpenAI (pictures, page layouts, their
models), and paid backups of the free services: Google Cloud Translation, used only when the free
translator fails, and Azure Speech, used only when Microsoft's free Natural voices refuse. Each
shows whether a key is saved (its last 4 characters), when, and a **Test** button. Keys are kept in
`web/server-config.json` on the server and never sent to a browser.

**Devices**: an account may be logged in on at most **2 devices** (admins: any number). A third
is refused with the names of the two. A device is freed by logging out on it, or unlinked by an
admin in the user's page (that login ends at once).

### Offline use and its time limit

On a phone or computer, the website can be added to the home screen (it is a web app) and works
without internet: the app's files and every book that was opened stay on the device, with their
audio and scripts. Each time the server is reached, it says until when the device may stay
offline (the plan's offline time; 3 days by default). After that — or when the device's clock was
moved back — the whole app shows **Connect to the internet to continue** until the server is
reached again, and then opens at once. A small sign shows how long the app still works while
offline. An account whose **Offline use** is switched off keeps nothing on the device.

### A student's computer (the Windows copy)

A student can run the app on their own Windows computer with **Start as a student.bat** (change
`SITE` in it to your website's address). It never shows the disc's books. The student logs in with
their website account (the computer counts as one of the account's 2 devices), opens the
**Website** tab and downloads the books their plan allows — pages, text, audio and video, play
buttons and scripts — into **My books**. The app checks the account with the website every 10
minutes; without the website it works for the plan's offline time, then locks the books until the
website is reached again (as above).

### Admins and the Users tab

The **owner** is the account with the e-mail in `LB_ADMIN_EMAIL`. In **Library → Admin → Users**
the owner sees every account (role, plan, last seen, books) and opens one to:

- give it plan days without a code (7, 30, 90, 365 or another number; all shared books or chosen
  ones; added after a plan of the same books that has not ended), or take a plan away;
- **block** it (logged out at once, cannot log in) and unblock it;
- set a **new password** when the user forgot theirs (the site sends no e-mails); the account is
  logged out everywhere;
- **make it an admin** (a helper admin) or a user again — only the owner does this;
- **delete** it, with its books, MP3s, new words and imports.

Helper admins manage users, books, reports and codes, but not other admins or the owner, and they
cannot change the API keys (ElevenLabs, OpenAI): only the owner can. Nobody blocks, deletes or
demotes the owner or themselves.

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
