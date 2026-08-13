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

Omnibus deploys as **three containers**: the web app, the **Rust engine** (the heavy-lifting sidecar that runs library scans, CBR/CBZ conversion, downloads, metadata sync, and search), and Redis (the job queue). The database is still serverless SQLite living on your `/config` volume — no database server required.

> **⚠️ Upgrading from v1.1.x?** v1.2.0 split Omnibus into two application containers: the web app now **requires** the `omnibus-engine` sidecar. If you pull the new image into your old compose file, every scan/conversion/metadata/search job fails with `fetch failed` and the health panel reports "Engine unreachable." Update your `docker-compose.yml` to the layout below — add the `omnibus-engine` service and the `OMNIBUS_ENGINE_URL` variable, and give the engine the **same** `NEXTAUTH_SECRET` and volume mounts as the web app. Your database and config carry over untouched; the schema upgrades itself on first boot.

1.  Save the following as `docker-compose.yml`:

<!-- end list -->

```yaml
version: '3.8'

services:
  omnibus:
    image: ghcr.io/hankscafe/omnibus:latest
    container_name: omnibus
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      - omnibus-redis
      - omnibus-engine
    environment:
      - TZ=America/New_York
      
      # REQUIRED: The canonical URL of your Omnibus instance. NextAuth requires this to match exactly.
      # Local access only: Set to your NAS IP and port (e.g., http://192.168.1.50:3000)
      # External access: Set to your public domain (e.g., https://omnibus.yourdomain.com)
      # NOTE: Do NOT include a trailing slash!
      - NEXTAUTH_URL=http://<your-ip:port>
      
      # REQUIRED: Generate a random string for security
      # !!NOTE!! - NEXTAUTH_SECRET also works as master database encryption key. !!DO NOT LOSE THIS!!
      # !!NOTE!! - Must be the SAME value as NEXTAUTH_SECRET in the omnibus-engine service below.
      - NEXTAUTH_SECRET=

      # --- ADVANCED SECURITY SETTINGS ---
      # By default, Omnibus requires an HTTPS connection to use the "Login As" (Impersonation) feature 
      # to prevent session tokens from being intercepted over the network.
      # If you are running Omnibus on a secure, private home network (LAN) without SSL, 
      # uncomment the line below to bypass this restriction at your own risk.
      # - ALLOW_INSECURE_IMPERSONATION=true
      
      # REQUIRED: Connection URL for the background job queue
      - OMNIBUS_REDIS_URL=redis://omnibus-redis:6379/0
      
      # REQUIRED: The Rust engine sidecar (service below). Scans, conversions, downloads,
      # metadata sync, and search all run there — without it those jobs fail with "fetch failed".
      - OMNIBUS_ENGINE_URL=http://omnibus-engine:8000
      
      # REQUIRED: Database connection string
      - DATABASE_URL=file:/config/omnibus.db
      
      # PRE-STAGED PATHS: These automatically create subfolders inside your mapped /config volume below
      - OMNIBUS_CACHE_DIR=/config/cache
      - OMNIBUS_LOGS_DIR=/config/logs
      - OMNIBUS_BACKUPS_DIR=/config/backups

      # DROP FOLDERS: Set these inside your single data mount for fast atomic moves!
      - OMNIBUS_WATCHED_DIR=/data/watched
      - OMNIBUS_AWAITING_MATCH_DIR=/data/unmatched

      # OPTIONAL: default file-permission mask for everything Omnibus creates (the *arr convention).
      # On NAS/shared storage, new folders are otherwise 0755 and read-only for your other accounts.
      # 000 = world-writable (0777 folders), 002 = group-writable (0775). Also normalizes folders the
      # Smart Matcher relocates. Set the SAME value on the engine service below. Unset = no change.
      # - UMASK=002

    volumes:
      # REQUIRED: Persistent storage for Database, Logs, Backups, Cache, and Uploaded Images
      - /path/to/your/nas/config:/config
      
      # -------------------------------------------------------------------------
      # OPTION 1: The Recommended Single Data Mount (Fast Atomic Moves/Hardlinks)
      # -------------------------------------------------------------------------
      # Maps your entire media/download root to /data for optimal performance
      - /path/to/your/nas/data:/data 
      
      # -------------------------------------------------------------------------
      # OPTION 2: Separate Mounts (Slower copy/paste/delete operations)
      # Uncomment these and remove Option 1 if your folders are on different drives
      # -------------------------------------------------------------------------
      # - /path/to/your/nas/comics:/comics
      # - /path/to/your/nas/manga:/manga
      # - /path/to/your/nas/downloads:/downloads
      # - /path/to/your/nas/watched:/watched
      # - /path/to/your/nas/unmatched:/unmatched

  # --- Rust engine: REQUIRED since v1.2.0 ---
  # The heavy-lifting sidecar: library scans, CBR/CBZ conversion, downloads, metadata sync,
  # search, and backups all run here. The web app forwards those jobs to it over the internal
  # Docker network.
  omnibus-engine:
    image: ghcr.io/hankscafe/omnibus-engine:latest
    container_name: omnibus-engine
    restart: unless-stopped
    environment:
      - TZ=America/New_York
      
      # Same SQLite database file as the web app (via the shared /config volume).
      - DATABASE_URL=file:/config/omnibus.db
      - OMNIBUS_ENGINE_BIND=0.0.0.0:8000
      
      # The engine calls back to the web app to fire job-completion notifications.
      - OMNIBUS_NODE_URL=http://omnibus:3000
      
      # REQUIRED: MUST be the exact same value as the web app's NEXTAUTH_SECRET above.
      # The engine refuses to start network-exposed without a real secret.
      - NEXTAUTH_SECRET=
      
      # Keep these identical to the web app so both containers resolve the same files.
      - OMNIBUS_BACKUPS_DIR=/config/backups
      - OMNIBUS_CACHE_DIR=/config/cache
      - OMNIBUS_WATCHED_DIR=/data/watched
      - OMNIBUS_AWAITING_MATCH_DIR=/data/unmatched

      # OPTIONAL: match the web app's UMASK (see above) so both containers create files the same way.
      # - UMASK=002
    # No ports exposed to the host: only the web container reaches the engine internally.
    # Publishing 8000 would expose the DB-/filesystem-mutating engine API to your LAN.
    volumes:
      # MUST be the SAME mounts as the web app (the engine reads/writes the same database
      # and comic files at the same paths).
      - /path/to/your/nas/config:/config
      - /path/to/your/nas/data:/data

  omnibus-redis:
    image: redis:alpine
    container_name: omnibus-redis
    restart: unless-stopped
    # No ports exposed to the host machine to prevent conflicts. 
    # Omnibus connects to this purely via Docker's internal network.
```

2.  Run `docker-compose up -d`.
3.  Open your browser and navigate to your `NEXTAUTH_URL` to access the initial Setup Wizard\!

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