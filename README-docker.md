# Omnibus

**The ultimate all-in-one, self-hosted comic book and manga app.**

<div align="center">

  [![Build Status](https://img.shields.io/github/actions/workflow/status/hankscafe/omnibus/docker-publish.yml?branch=main&style=for-the-badge&logo=github&label=Build)](https://github.com/hankscafe/omnibus/actions/workflows/docker-publish.yml)
  [![Test Status](https://img.shields.io/github/actions/workflow/status/hankscafe/omnibus/test-and-notify.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/hankscafe/omnibus/actions/workflows/test-and-notify.yml)
  [![Docker Image (GHCR)](https://img.shields.io/badge/Docker-GHCR-blue?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/hankscafe/omnibus/pkgs/container/omnibus)
  [![Docker Hub Version](https://img.shields.io/docker/v/hankscafe/omnibus.svg?style=for-the-badge&logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/hankscafe/omnibus)
  [![Docker Pulls](https://img.shields.io/docker/pulls/hankscafe/omnibus.svg?style=for-the-badge&logo=docker)](https://hub.docker.com/r/hankscafe/omnibus)
  [![Docker Image Size](https://img.shields.io/docker/image-size/hankscafe/omnibus/latest.svg?style=for-the-badge&logo=docker)](https://hub.docker.com/r/hankscafe/omnibus)
  [![License](https://img.shields.io/github/license/hankscafe/omnibus?style=for-the-badge&color=green)](https://github.com/hankscafe/omnibus/blob/main/LICENSE)
  [![GitHub Stars](https://img.shields.io/github/stars/hankscafe/omnibus?style=for-the-badge&logo=github&color=yellow)](https://github.com/hankscafe/omnibus/stargazers)
  [![Discord](https://img.shields.io/discord/1483588541341503500?style=for-the-badge&logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/YDf9bqRgpQ)

</div>

**Omnibus** is a self-hosted web application built specifically for the comic book and manga community. It seamlessly bridges the gap between discovering, requesting, downloading, managing, and reading your digital collection.

Built with Next.js 15, Tailwind v4, Prisma, and a serverless SQLite engine, Omnibus is lightweight, performant, and responsive across all devices.

**For full documentation, screenshots, and deep-dive feature breakdowns, please visit the [Official Omnibus GitHub Repository](https://github.com/hankscafe/omnibus).**

## Core Features

  * **Dual Metadata Engines:** Choose between ComicVine (default) or Metron.Cloud as your primary source to automatically pull high-res covers, synopses, and creator credits. 
  * **All-In-One Pipeline:** Discover new releases, request missing issues, send them to your download clients (qBittorrent, SABnzbd, etc.), and read them—all from one interface.
  * **Native Web Reader:** Blazing fast, zero-friction browser reading for `.cbz`, `.cbr`/`.rar` (read natively by the Rust engine — auto-conversion to cbz stays optional), and `.epub` archives with LTR, RTL (Manga), and Webtoon scroll support.
  * **Automated Organization & Smart Matcher:** Auto-extracts, renames, and routes downloaded files to your mapped library directories. Unmatched loose files can be instantly organized using the AI-assisted Smart Matcher with support for both ComicVine and Metron IDs.
  * **Smart Reading Lists:** Instantly auto-build reading orders by pasting a ComicVine or Metron Event ID. Easily import external lists from CBL files, CSVs (League of Comic Geeks), AniList, or MyAnimeList.
  * **Release Calendar & Discovery:** Track upcoming global comic releases and maintain a personalized pull list (powered by Metron), complete with color-coded library badges to instantly spot missing or unreleased issues.
  * **Multi-User & Secure:** NextAuth integration with OpenID Connect (SSO), 2FA, and distinct reading progress tracking for friends and family.
  * **External Reading (OPDS & KOReader):** Native OPDS 1.2 server with Page Streaming Extension (PSE) for apps like Panels and Mihon, plus native e-ink sync for KOReader devices.

-----

## Installation (Docker Compose)

Omnibus runs as **three containers** that start together with Docker Compose:

* **the web app** — the site you open in your browser;
* **the Rust engine** — the heavy lifting: library scans, CBR/CBZ conversion, downloads, metadata sync, and search;
* **Redis** — the background job queue.

The database is a single SQLite file in your config folder, so there is no database server to run. (Very large library? PostgreSQL is optional — see [Choosing your database](https://github.com/hankscafe/omnibus/blob/main/UPGRADING.md#choosing-your-database-sqlite-or-postgresql).)

> **Already running Omnibus?** To update, run `docker compose pull` and then `docker compose up -d`. Coming from v1.1.x, or using QNAP Container Station? Read [UPGRADING.md](https://github.com/hankscafe/omnibus/blob/main/UPGRADING.md) first.

### Before you start

* **Docker with Docker Compose** on the machine that will run Omnibus. Docker Desktop (Windows/macOS) includes Compose; on Linux, follow [Docker's install guide](https://docs.docker.com/engine/install/) and check that `docker compose version` works.
* **A free ComicVine API key** — Omnibus' default source for covers, synopses, and issue lists. Create an account at [comicvine.gamespot.com](https://comicvine.gamespot.com/), then open [comicvine.gamespot.com/api](https://comicvine.gamespot.com/api/) to see your key. ([Metron.Cloud](https://metron.cloud/) is an optional second source.)
* **Optional — add them whenever you like:** Prowlarr (indexer search), a download client (qBittorrent, SABnzbd, …), FlareSolverr. You don't need any of them to organize and read the comics you already have.

### Step 1 — Make the folders

Pick a home for Omnibus on your server, for example:

```
omnibus/
├── docker-compose.yml   ← you'll create this in step 3
├── config/              ← database, logs, cache, backups (Omnibus fills this)
└── data/
    ├── comics/          ← your comic library — copy existing comics here
    └── downloads/       ← finished downloads land here
```

* Keep `config/` on a disk in the server itself, **not a network share** — the SQLite database can be corrupted over SMB/NFS. `data/` can live on a NAS share.
* Keep `comics/` and `downloads/` inside the one `data/` folder so Omnibus moves files instantly instead of copying them.
* Comics already somewhere else? Point the data mount (step 3) at the folder that holds them instead — e.g. `/mnt/media:/data` when your comics are in `/mnt/media/comics`.
* On Linux, the web container runs as user ID 1000, which must be able to write to `config/` and `data/`. Create the folders as your regular user rather than with `sudo`: a folder Docker creates for you is owned by root, and the web app can't create its database there. (`sudo chown -R 1000:1000 config data` fixes that.)

### Step 2 — Make a secret

```bash
openssl rand -base64 48
```

Copy the output (any random string of 40+ characters works too). This is your `NEXTAUTH_SECRET`: it signs logins **and** encrypts the passwords and API keys Omnibus saves. Keep a copy somewhere safe — without it, those saved values can't be read and backups can't be restored.

### Step 3 — Create `docker-compose.yml`

Save the file below as `docker-compose.yml` in your `omnibus` folder, then fill in the lines marked `CHANGE ME`:

| Setting | What to put there |
| --- | --- |
| `NEXTAUTH_URL` | The address you'll type into your browser: your server's IP and port 3000, e.g. `http://192.168.1.50:3000` — no trailing slash. Behind a domain or reverse proxy? Use that address instead, e.g. `https://omnibus.example.com`. |
| `NEXTAUTH_SECRET` | Your secret from step 2 — in **both** the `omnibus` and `omnibus-engine` services. |
| `TZ` | Your [timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Europe/London` — in both services. |
| `volumes` | `./config` and `./data` work as written when the folders sit next to this file; otherwise use full paths. Keep the two lines **identical in both services**. |

```yaml
services:
  omnibus:
    image: ghcr.io/hankscafe/omnibus:latest
    container_name: omnibus
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      omnibus-redis:
        condition: service_healthy
      omnibus-engine:
        condition: service_started
    environment:
      # CHANGE ME: your timezone (the same value in the engine below)
      - TZ=America/New_York

      # CHANGE ME: the address you open Omnibus at. It must match exactly, with no trailing slash.
      # On your network: your server's IP and port (e.g. http://192.168.1.50:3000)
      # Behind a domain or reverse proxy: that address (e.g. https://omnibus.yourdomain.com)
      - NEXTAUTH_URL=http://YOUR-SERVER-IP:3000

      # CHANGE ME: paste your secret (generate one with: openssl rand -base64 48).
      # !!NOTE!! - It also encrypts the passwords and API keys Omnibus saves. !!DO NOT LOSE THIS!!
      # !!NOTE!! - Must be the SAME value as NEXTAUTH_SECRET in the omnibus-engine service below.
      - NEXTAUTH_SECRET=

      # --- ADVANCED SECURITY SETTINGS ---
      # By default, Omnibus requires an HTTPS connection to use the "Login As" (Impersonation) feature
      # to prevent session tokens from being intercepted over the network.
      # If you are running Omnibus on a secure, private home network (LAN) without SSL,
      # uncomment the line below to bypass this restriction at your own risk.
      # - ALLOW_INSECURE_IMPERSONATION=true

      # Everything below can stay as it is.

      # The background job queue (the omnibus-redis service below)
      - OMNIBUS_REDIS_URL=redis://omnibus-redis:6379/0

      # The Rust engine (the omnibus-engine service below). Scans, conversions, downloads,
      # metadata sync, and search all run there — without it those jobs fail with "fetch failed".
      - OMNIBUS_ENGINE_URL=http://omnibus-engine:8000

      # The database: a SQLite file in your config folder
      - DATABASE_URL=file:/config/omnibus.db

      # Folders inside the containers; they're created inside your config and data folders
      - OMNIBUS_CACHE_DIR=/config/cache
      - OMNIBUS_LOGS_DIR=/config/logs
      - OMNIBUS_BACKUPS_DIR=/config/backups
      - OMNIBUS_WATCHED_DIR=/data/watched
      - OMNIBUS_AWAITING_MATCH_DIR=/data/unmatched

      # OPTIONAL: default file-permission mask for everything Omnibus creates (the *arr convention).
      # On NAS/shared storage, new folders are otherwise 0755 and read-only for your other accounts.
      # 000 = world-writable (0777 folders), 002 = group-writable (0775). Also normalizes folders the
      # Smart Matcher relocates. Set the SAME value on the engine service below. Unset = no change.
      # - UMASK=002

    volumes:
      # <folder on your server>:<folder inside the container> — only ever change the LEFT side,
      # and keep these lines identical in the omnibus-engine service below.
      # Database, logs, cache, and backups. Local disk only, not a network share.
      - ./config:/config
      # Your comics and downloads (./data/comics, ./data/downloads). One mount = instant moves.
      - ./data:/data

      # Folders on separate drives? Replace the ./data line with one line per folder, all under
      # /data, and copy the same lines to the engine below. Moves between separate mounts are
      # copies, so they're slower.
      # - /path/to/comics:/data/comics
      # - /path/to/manga:/data/manga
      # - /path/to/downloads:/data/downloads
      # - /path/to/watched:/data/watched
      # - /path/to/unmatched:/data/unmatched

  # --- Rust engine: the heavy lifting (required) ---
  # Library scans, CBR/CBZ conversion, downloads, metadata sync, search, and backups all run
  # here. The web app forwards those jobs to it over Docker's internal network.
  omnibus-engine:
    image: ghcr.io/hankscafe/omnibus-engine:latest
    container_name: omnibus-engine
    restart: unless-stopped
    environment:
      # CHANGE ME: the same timezone as the web app
      - TZ=America/New_York

      # CHANGE ME: the SAME secret as the web app's NEXTAUTH_SECRET above.
      # The engine refuses to start without a real secret.
      - NEXTAUTH_SECRET=

      # Everything below can stay as it is.

      # The same SQLite database file as the web app (via the shared /config volume)
      - DATABASE_URL=file:/config/omnibus.db
      - OMNIBUS_ENGINE_BIND=0.0.0.0:8000

      # The engine calls back to the web app to fire job-completion notifications.
      - OMNIBUS_NODE_URL=http://omnibus:3000

      # Identical to the web app so both containers resolve the same files
      - OMNIBUS_BACKUPS_DIR=/config/backups
      - OMNIBUS_CACHE_DIR=/config/cache
      - OMNIBUS_WATCHED_DIR=/data/watched
      - OMNIBUS_AWAITING_MATCH_DIR=/data/unmatched

      # OPTIONAL: match the web app's UMASK (see above) so both containers create files the same way.
      # - UMASK=002
    # No ports: only the web app talks to the engine, over Docker's internal network.
    # Publishing 8000 would expose the DB-/filesystem-mutating engine API to your LAN.
    volumes:
      # The SAME lines as the web app's volumes above: the engine reads and writes the same
      # database and comic files at the same paths.
      - ./config:/config
      - ./data:/data

  # --- Redis: the background job queue ---
  omnibus-redis:
    image: redis:7-alpine
    container_name: omnibus-redis
    restart: unless-stopped
    # No ports: only the web app talks to Redis, over Docker's internal network.
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
```

> **Using Portainer, Synology Container Manager, Unraid, or another web UI that takes a compose file?** Paste the same file, but give the volumes **full paths** (e.g. `/volume1/docker/omnibus/config:/config`) — some of those tools resolve `./` somewhere other than you'd expect.

This is the same stack as the repo's [`docker-compose.yml`](https://github.com/hankscafe/omnibus/blob/main/docker-compose.yml), written out with folder mounts instead of Docker-managed volumes. Use one or the other, not both.

### Step 4 — Start it

From your `omnibus` folder:

```bash
docker compose up -d
```

(Older Docker installs spell it `docker-compose up -d`.) Then check that all three containers are running:

```bash
docker compose ps
```

`omnibus`, `omnibus-engine`, and `omnibus-redis` should all show **Up**; the first start can take a minute while the database is created. If one keeps restarting, its log says why — for example `docker compose logs omnibus-engine`. A missing `NEXTAUTH_SECRET` is the usual cause.

### Step 5 — Run the Setup Wizard

Open your `NEXTAUTH_URL` in a browser. The wizard creates your admin account first, then asks for your ComicVine key. Every later step — indexers, download clients, hosters, network, users, filters, alerts, SSO — can be skipped with **Next** and set up any time in **Admin → Settings**.

On the **Paths** step (*Storage Mappings*), enter folders the way the containers see them — inside `/data`, not the folder names on your server. With the layout from step 1:

| Wizard field | Enter |
| --- | --- |
| Download Scan Root | `/data/downloads` |
| Library Folders → Path | `/data/comics` |

When you're done, the **System Health** card on the Admin page checks your setup — the engine connection, your ComicVine key, and whether the download folder is writable.

### Behind a reverse proxy or Cloudflare Tunnel?

Manual comic uploads are large requests, and proxies commonly cap request bodies:

- **Cloudflare (including Tunnels):** free and pro plans cap each request at ~100MB, and this cannot be raised. Omnibus v1.3+ automatically slices manual uploads into ~48MB chunks, so uploads of any size work through a tunnel. On older versions, upload from your LAN address instead.
- **nginx / Nginx Proxy Manager:** `client_max_body_size` defaults to just **1MB**. Add `client_max_body_size 2048m;` (NPM: Edit Proxy Host → Advanced) so single-request uploads and other large calls aren't rejected with HTTP 413.

Omnibus' own upload limit is 2GB per file, adjustable with the `OMNIBUS_MAX_UPLOAD_MB` environment variable on the web container.

## Support & Community

If you run into issues, have suggestions, or want to contribute, please join the community:

  * [**Report a Bug / Request a Feature**](https://github.com/hankscafe/omnibus/issues)
  * [**Join the Discord**](https://discord.gg/YDf9bqRgpQ)
  * **Pull requests welcome!** Community contributions are credited in the [Contributors section](https://github.com/hankscafe/omnibus#contributors) of the main README.