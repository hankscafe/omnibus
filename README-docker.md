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

**For full documentation, screenshots, and deep-dive feature breakdowns, please visit the [Official Omnibus GitHub Repository](https://www.google.com/search?q=https://github.com/hankscafe/omnibus).**

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
    environment:
      - TZ=America/New_York
      # REQUIRED: Set to your Cloudflare Tunnel domain (e.g., https://omnibus.mydomain.com)
      # or your NAS IP (e.g., http://192.168.1.100:3000)
      - NEXTAUTH_URL=http://192.168.1.100:3000
      
      # REQUIRED: Generate a random 32-character string for security.
      # !!NOTE!! - This also works as the master database encryption key. DO NOT LOSE THIS!
      - NEXTAUTH_SECRET=your_super_secret_random_string
      
      # REQUIRED: Path configurations
      - CACHE_DIR=/cache
      - DATABASE_URL=file:/config/omnibus.db
      - LOG_PATH=/logs
      # OPTIONAL: Defines backup path (defaults to /backups if omitted)
      - OMNIBUS_BACKUP_DIR=/backups

    volumes:
      # SYSTEM MOUNTS (Required)
      - /path/to/your/nas/config:/config
      - /path/to/your/nas/cache:/cache
      - /path/to/your/nas/backups:/backups
      - /path/to/your/nas/logs:/logs
      - /path/to/your/nas/avatars:/app/public/avatars
      - /path/to/your/nas/banners:/app/public/banners
      
      # MEDIA MOUNTS
      # OPTION 1: Recommended Single Data Mount (Fast Atomic Moves/Hardlinks)
      - /path/to/your/nas/data:/data 
      
      # OPTION 2: Separate Mounts (Slower copy/paste/delete operations)
      # Uncomment these and remove Option 1 if your folders are on different drives
      # - /path/to/your/nas/comics:/comics
      # - /path/to/your/nas/manga:/manga
      # - /path/to/your/nas/downloads:/downloads
```

2.  Run `docker-compose up -d`.
3.  Open your browser and navigate to your `NEXTAUTH_URL` to access the initial Setup Wizard\!

## Support & Community

If you run into issues, have suggestions, or want to contribute, please join the community:

  * [**Report a Bug / Request a Feature**](https://www.google.com/search?q=https://github.com/hankscafe/omnibus/issues)
  * [**Join the Discord**](https://discord.gg/FBnzdBZP)