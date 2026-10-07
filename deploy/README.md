# Putting the app on your own website

The app runs on a small server of your own, behind a password. GitHub keeps the **code**;
the **book content** (about 1 GB, Oxford University Press's) and **your data** (corrections,
MP3s, translations) go from your computer straight to the server.

```
your computer ── git push ──▶ GitHub (private) ── update.sh ──▶ server ◀── upload-content.ps1 ── your computer
                                                                  │
                                                     https://your-domain  (phones, tablets, computers)
```

## What you need

- A **VPS** (virtual server), not "shared hosting": the app needs its Python helper running
  all the time. Ubuntu 22.04 or 24.04, 1–2 GB memory, 25 GB disk or more.
  For example Hetzner, DigitalOcean, Contabo, Vultr (about 5–10 US$ a month).
- A **domain** (or a subdomain such as `aef.your-domain.com`). In the domain's DNS settings,
  add an **A record** that points to the server's IP address.
- A **GitHub** account with a **private** repository for the code.

## 1. Code to GitHub (on your computer, once)

Create an empty **private** repository on github.com (no README, no .gitignore). Then in this
folder:

```
git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
git push -u origin main
```

The first push opens a browser window to sign in to GitHub.

## 2. Set up the server (once)

Log in to the server (`ssh root@SERVER-IP`) and run:

```
curl -O https://raw.githubusercontent.com/YOUR-NAME/YOUR-REPO/main/deploy/setup-server.sh
```

(For a private repository that link does not work: copy the file instead, from your computer:
`scp deploy\setup-server.sh root@SERVER-IP:` )

```
bash setup-server.sh your-domain.com git@github.com:YOUR-NAME/YOUR-REPO.git
```

It shows a key: add it on GitHub (repository → **Settings → Deploy keys → Add deploy key**,
"Allow write access" off), then press Enter. It asks for the **password** of the website.

## 3. Copy the content and your data (on your computer)

```
powershell -ExecutionPolicy Bypass -File deploy\upload-content.ps1 -Server root@SERVER-IP
```

About 1 GB the first time. Later, `-SkipContent` copies only your data again.

Open `https://your-domain.com` and log in. On a phone: browser menu → **Add to Home screen**,
and the app opens full screen with its own icon.

## Updates

Change the code on your computer, test it, then:

```
git add -A
git commit -m "What changed"
git push
ssh root@SERVER-IP /opt/aef3/deploy/update.sh
```

## Good to know

- Where things are on the server: code and content in `/opt/aef3`, your data in
  `/var/lib/aef3`, the password in `/etc/aef3.env` (change it there, then
  `systemctl restart aef3`).
- Log in again after 30 days, or after the password was changed.
- Back up `/var/lib/aef3` now and then (or keep working on your computer and upload).
- The website is for your own use. Making Oxford's books open to others needs their permission.
