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

## 1. Code to GitHub

Already done: https://github.com/mhmdnojim/American-English-File-2e-Level-3 (you can rename it
on GitHub: Settings → General → Repository name; the old address keeps working). Later changes:

```
git add -A
git commit -m "What changed"
git push
```

## 2. Set up the server (once)

Log in to the server (`ssh root@SERVER-IP`) and run:

```
curl -O https://raw.githubusercontent.com/mhmdnojim/American-English-File-2e-Level-3/main/deploy/setup-server.sh
bash setup-server.sh your-domain.com https://github.com/mhmdnojim/American-English-File-2e-Level-3.git
```

(For a **private** repository use the `git@github.com:…` address instead: the script then shows
a key to add on GitHub under Settings → Deploy keys.)

It asks for **your e-mail address**: when you sign up on the website with it, you are the
**admin** (you see the *Admin* tab: reports, hiding and deleting books).

Open `https://your-domain.com`, **Sign up** with that e-mail, and add the first books.

## Updates

After `git push`:

```
ssh root@SERVER-IP /opt/lingua-books/deploy/update.sh
```

## Good to know

- Where things are on the server: the code in `/opt/lingua-books`, everything people add in
  `/var/lib/lingua-books`, the settings in `/etc/lingua-books.env` (after a change:
  `systemctl restart lingua-books`).
- **Backups**: `/opt/lingua-books/deploy/backup.sh` makes one file with everything; copy it to
  your computer now and then (`scp root@SERVER-IP:/root/lingua-books-*.tar.gz .`).
- **Limits** for each account (in `web/library.py`, `LIMITS`): 100 books, 600 MB, PDFs up to
  60 MB and 300 pages, 200 photos per book, 30 new books and 40 MP3s a day. Admins have no limits.
- **Reports**: a book reported by three different people is hidden at once until an admin looks
  at it (Admin tab). Answer copyright complaints quickly: hide or delete the book.
- Photos of pages are read with **Tesseract** on the server; translations use Google's free
  translator and MP3s Microsoft's online voices (see the terms page).
