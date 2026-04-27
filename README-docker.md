# Omnibus

**The ultimate all-in-one, self-hosted comic book and manga app.**

<div align="center">

  [![Build Status](https://img.shields.io/github/actions/workflow/status/hankscafe/omnibus/docker-publish.yml?branch=main&style=for-the-badge&logo=github&label=Build)](https://github.com/hankscafe/omnibus/actions/workflows/docker-publish.yml)
  [![Docker Image (GHCR)](https://img.shields.io/badge/Docker-GHCR-blue?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/hankscafe/omnibus/pkgs/container/omnibus)
  [![Docker Hub Version](https://img.shields.io/docker/v/hankscafe/omnibus.svg?style=for-the-badge&logo=docker&label=Docker%20Hub)](https://hub.docker.com/r/hankscafe/omnibus)
  [![Docker Pulls](https://img.shields.io/docker/pulls/hankscafe/omnibus.svg?style=for-the-badge&logo=docker)](https://hub.docker.com/r/hankscafe/omnibus)
  [![Docker Image Size](https://img.shields.io/docker/image-size/hankscafe/omnibus/latest.svg?style=for-the-badge&logo=docker)](https://hub.docker.com/r/hankscafe/omnibus)
  [![License](https://img.shields.io/github/license/hankscafe/omnibus?style=for-the-badge&color=green)](https://github.com/hankscafe/omnibus/blob/main/LICENSE)
  [![GitHub Stars](https://img.shields.io/github/stars/hankscafe/omnibus?style=for-the-badge&logo=github&color=yellow)](https://github.com/hankscafe/omnibus/stargazers)
  [![Discord](https://img.shields.io/discord/1483588541341503500?style=for-the-badge&logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/FBnzdBZP)

</div>

**Omnibus** is a self-hosted web application built specifically for the comic book and manga community. It seamlessly bridges the gap between discovering, requesting, downloading, managing, and reading your digital collection.

Built with Next.js 15, Tailwind v4, Prisma, and a serverless SQLite engine, Omnibus is lightweight, performant, and responsive across all devices.

**For full documentation, screenshots, and deep-dive feature breakdowns, please visit the [Official Omnibus GitHub Repository](https://github.com/hankscafe/omnibus).**

## Core Features

  * **All-In-One Pipeline:** Discover new releases via ComicVine, request missing issues, send them to your download clients (qBittorrent, SABnzbd, etc.), and read them—all from one interface.
  * **Native Web Reader:** Blazing fast, zero-friction browser reading for `.cbz`, `.cbr` (auto-converts to cbz), and `.epub` archives with LTR, RTL (Manga), and Webtoon scroll support.
  * **Automated Organization:** Auto-extracts, renames, and moves downloaded files to your mapped library directories.
  * **Multi-User & Secure:** NextAuth integration with OpenID Connect (SSO), 2FA, and distinct reading progress tracking for friends and family.
  * **Smart Reading Lists:** Paste a ComicVine Event ID (e.g., *Marvel Civil War*) and Omnibus will automatically generate the official reading order and map your existing files to it.

-----

## Installation (Docker Compose)

Omnibus is built to be deployed via Docker. Because it utilizes a serverless SQLite engine, **all necessary database files and dependencies are bundled directly into the image.** There are no external database containers required.

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
    environment:
      - TZ=America/New_York
      
      # REQUIRED: The canonical URL of your Omnibus instance. NextAuth requires this to match exactly.
      # Local access only: Set to your NAS IP and port (e.g., http://192.168.1.50:3000)
      # External access: Set to your public domain (e.g., https://omnibus.yourdomain.com)
      # NOTE: Do NOT include a trailing slash!
      - NEXTAUTH_URL=http://<your-ip:port>
      
      # REQUIRED: Generate a random string for security
      # !!NOTE!! - NEXTAUTH_SECRET also works as master database encryption key. !!DO NOT LOSE THIS!!
      - NEXTAUTH_SECRET=
      
      # REQUIRED: Connection URL for the background job queue
      - OMNIBUS_REDIS_URL=redis://omnibus-redis:6379/0
      
      # REQUIRED: Database connection string
      - DATABASE_URL=file:/config/omnibus.db
      
      # PRE-STAGED PATHS: These automatically create subfolders inside your mapped /config volume below
      - OMNIBUS_CACHE_DIR=/config/cache
      - OMNIBUS_LOGS_DIR=/config/logs
      - OMNIBUS_BACKUPS_DIR=/config/backups

      # DROP FOLDERS: Set these inside your single data mount for fast atomic moves!
      - OMNIBUS_WATCHED_DIR=/data/watched
      - OMNIBUS_AWAITING_MATCH_DIR=/data/unmatched

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

  omnibus-redis:
    image: redis:alpine
    container_name: omnibus-redis
    restart: unless-stopped
    # No ports exposed to the host machine to prevent conflicts. 
    # Omnibus connects to this purely via Docker's internal network.
```

2.  Run `docker-compose up -d`.
3.  Open your browser and navigate to your `NEXTAUTH_URL` to access the initial Setup Wizard\!

## Support & Community

If you run into issues, have suggestions, or want to contribute, please join the community:

  * [**Report a Bug / Request a Feature**](https://github.com/hankscafe/omnibus/issues)
  * [**Join the Discord**](https://discord.gg/FBnzdBZP)