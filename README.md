# Omnibus

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/banner.png?raw=true" alt="Omnibus Banner" />
  <br>
  <em>The ultimate all-in-one, self-hosted comic book and manga app.</em>
</p>

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

**Omnibus** is the ultimate all-in-one, self-hosted web application built specifically for the comic book and manga community. It seamlessly bridges the gap between discovering, requesting, downloading, managing, and reading your digital collection.

I am not a traditional programmer, but I was inspired to "vibe-code" this project after discovering [ReadMeABook](https://github.com/kikootwo/ReadMeABook) on Reddit.

Self-hosting audiobooks, eBooks, and comic books has always presented a challenge for me: how do you seamlessly handle user requests, find the files, and automatically add them to a library? Having a system like [AudioBookShelf](https://github.com/advplyr/audiobookshelf) for managing metadata and streaming media is fantastic, but getting the files into the system and handling user requests usually meant manual searching or relying on a disjointed mix of auto-downloaders.

After using [ReadMeABook](https://github.com/kikootwo/ReadMeABook), I wanted a similar solution specifically tailored for comics. Comic indexers and tracking sites can be notoriously tricky due to inconsistent naming conventions and release formats (e.g., single issues vs. volumes vs. massive character collections). Using ReadMeABook's clean aesthetic as a starting point, I used AI to help build a comic-focused equivalent. What started as a simple request tool eventually evolved into a full-fledged library manager, metadata indexer, and web reader.

Built with Next.js 15, Tailwind v4, Prisma, and a serverless SQLite engine, Omnibus is designed to be lightweight, performant, and responsive across all your devices. Whether you are managing a massive archive of .cbz files, hunting down missing issues of your favorite run, or just looking for a clean, distraction-free web reader, Omnibus brings your entire comic universe under one roof.

While I know AI-assisted ("vibe-coded") projects can sometimes be met with skepticism, I genuinely enjoyed the process of watching this come together into a highly usable tool. If you run into issues, have suggestions, or want to contribute, please let me know! I gladly welcome any help or insights to make Omnibus even better.

---

## Table of Contents
- [About Omnibus](#about-omnibus)
- [Features & Navigation](#features--navigation)
  - [Authentication & Security](#authentication--security)
  - [Homepage](#homepage)
  - [Library & Metadata](#library--metadata)
  - [Series Page](#series-page)
  - [Web Reader](#web-reader)
  - [External Readers & OPDS Support](#external-readers--opds-support)
  - [Native e-Ink Sync (KOReader)](#native-e-ink-sync-koreader)
  - [Reading Lists](#reading-lists)
  - [User Profile & Preferences](#user-profile--preferences)
  - [Settings & Administration](#settings--administration)
  - [Additional Screenshots](#additional-screenshots)
- [Installation (Docker)](#installation-docker)
- [Acknowledgements](#acknowledgements)

---

## Features & Navigation

### Authentication & Security
The secure gateway to your personal comic universe. Omnibus ensures your collection remains private while offering a beautiful, welcoming entry point for you and your authorized users.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/login_page.png?raw=true" width="500" alt="Login page" />
  <br>
  <strong>Login page.</strong>
</p>

* **Secure Local Access:** Powered by NextAuth, featuring industry-standard encrypted sessions to keep your server, database, and physical files completely safe from the public internet.
* **Single Sign-On (SSO):** Natively supports OpenID Connect (OIDC). Integrate directly with Authelia, Authentik, Keycloak, or Google for seamless user onboarding.
* **Two-Factor Authentication (2FA):** Users can secure their local accounts using TOTP authenticator apps (Google Authenticator, Authy, Bitwarden).
* **Multi-User Gateway & Impersonation:** Create independent accounts for friends and family. Admins can even temporarily "Impersonate" users to help troubleshoot their accounts.
* **Active Session Management:** Logged in on a public computer? Revoke all other active sessions directly from your profile settings.
* **First-Time Setup Detection:** If the database is completely fresh and no administrator account exists yet, the login system intelligently redirects to the built-in Setup Wizard to help you configure your libraries.

### Homepage
The Dashboard is the personalized nerve center of your collection. It dynamically updates based on the logged-in user to provide a tailored snapshot of their reading journey.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/home_page.png?raw=true" width="500" alt="Homepage with Jump Back In section" />
  <br>
  <strong>Jump Back In section.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/home_page_discovery.png?raw=true" width="500" alt="Homepage discoery sections" />
  <br>
  <strong>Homepage discovery section with Popular Issues and New Releases.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/request_1.png?raw=true" width="500" alt="Series request from home page" />
  <br>
  <strong>Series window when clicking issue/series from the discover sections.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/request_2.png?raw=true" width="500" alt="Series request and monitor" />
  <br>
  <strong>Users can choose to monitor the series when they are making a request so future releases to a series will be automatically downloaded.</strong>
</p>

* **Responsive Design:** A beautifully styled, mobile-first interface that provides a frictionless login experience whether you are on a smartphone, tablet, or desktop monitor.
* **"Jump Back In" Shelf:** A dynamically updated carousel that tracks your exact page in ongoing issues. Jump back into the action with a single click.
* **"Recently Added" Section:** A dynamically updated carousel that shows the 7 most recent series addtions to the library with the ability to jump directly to that series page.
* **Discovery Feed:** Browse auto-updating "New Releases" and "Popular Issues" pulled directly from the ComicVine API and cached for performance.
* **Interactive Search:** Search the ComicVine database for any series or issue. View covers, publishers, and issue counts to ensure you are requesting exactly what you want.
* **Color-Coded Badges:** Omnibus uses a color-coded badge system on the Discover and Search grids to let you know exactly what is in your library and what the automated downloader is doing.
  * Series & Volume Badges:
    * 🟢 Monitored (Green with Activity/Pulse Icon): You own at least one issue of this series, AND Omnibus is actively monitoring it. Any newly released issues will be automatically downloaded in the background.
    * 🔵 In Library (Blue with Library/Books Icon): You own at least one issue of this series, but it is currently unmonitored. Omnibus will not automatically download new issues, but you can still manually request missing ones.
  * Individual Issue Badges:
    * 🟢 In Library (Emerald Green with File-Check Icon): The physical file for this specific issue has been successfully downloaded and is sitting on your hard drive ready to read.
  * Request Pipeline Badges:
    * 🟠 Requested (Orange with Clock Icon): You have requested this item. Omnibus has added it to the queue and is actively searching for a valid download source.
    * 🟡 Pending Approval (Yellow with Clock Icon): You have requested this item, but your server requires an Admin to manually approve the request before the search begins.
* **Smart Requests & Automation:** Send requests directly to your download queue. Omnibus searches GetComics first and directly downloads your request or utilizaes 3rd-party file hosters (based on your priority settings) and then falls back to your connected indexers (Prowlarr).
* **Upcoming Release Tracking:** Monitors your requested ongoing series for new weekly Wednesday releases and automatically grabs them as they are uploaded.
* **Unreleased Badges:** When a request is made Omnibus will check ComicVine for the issues release date and if it is not released it will tag it as UNRELEASED.  As the Monitor Series job runs it will also check items tagged as UNRELEASED and update it as available once it is availalbe, allowing future issues to be automatically downloaded.
* **Admin Action Alerts:** Admins get a top-level heads-up display alerting them of pending user approvals, manual download interventions, and broken file reports.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/admin_alerts.png?raw=true" width="500" alt="Admin alert banners" />
  <br>
  <strong>If a user submits an issue with a series or a request is waiting on admin approval, a banner will be visible to admins on the homepage.</strong>
</p>

### Library & Metadata
A meticulously organized, highly performant view of your physical files, built to handle massive, multi-terabyte collections smoothly.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/library.png?raw=true" width="500" alt="Library page" />
  <br>
  <strong>The library page which features infinite scrolling.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/library_action_buttons.png?raw=true" width="500" alt="Library page series action buttons" />
  <br>
  <strong>The library page action buttons.</strong>
</p>

* **Embedded Metadata (ComicInfo.xml):** Omnibus doesn't just read metadata—it writes it. Omnibus can automatically generate and embed standard `ComicInfo.xml` files directly into your `.cbz` archives, ensuring your metadata travels with your files.
* **Dual Megadata Engines:** Omnibus reads embedded ComicInfo.xml files inside your archives and syncs with the ComicVine API or Metron.Cloud (if configured) to pull high-res covers, synopses, and creator credits.
* **Advanced Search Syntax:** Use prefix modifiers in the search bar (e.g., `character:"Spider-Man"`, `team:"X-Men"`, `arc:"Secret Wars"`) to pinpoint exact crossovers and appearances across your entire collection.
* **Multi-Library Routing:** Map distinct folders for standard Comics and Manga. Omnibus automatically detects Manga based on publishers, AniList cross-referencing, and tags to route them to the correct directory.
* **Automated File Standardization:** Enforce clean, uniform file names across your entire server (e.g., [Publisher]/Series (Year)/Series - #Issue.cbz).
* **"Watched" Folder Auto-Ingestion:** Automate your library building by dropping loose `.cbz`, `.cbr`, `.zip`, and `.rar` files into a designated `watched` folder. Omnibus runs a scheduled background job to detect these files, read their `ComicInfo.xml` metadata, convert legacy formats, standardize the filenames, and perfectly sort them into your main library.
* **"Awaiting Match" Drop Queue:** If dropped files lack the necessary metadata for auto-ingestion, they are safely routed to an `unmatched` directory. Admins can review these loose files in the Smart Matcher UI, apply the correct ComicVine metadata with one click, and seamlessly inject them into the main library.
* **Deep Filtering & Sorting:** Filter by Publisher, Genre, Format, Era (1980s, 1990s, etc.), and Read Status.
  * Try the "Surprise Me" button for a randomized library shuffle when you don't know what to read!
* **Smart Progress Badging:** Visual overlay indicators on covers to instantly show reading progress bars and how many unread issues remain in a series.
* **Cross-Series Curations:** Create custom lists that span multiple series, volumes, and publishers seamlessly.
* **Issue Grid & List Modes:** Toggle between a visual cover grid or a condensed list view to easily navigate massive collections.

### Series Page
The dedicated hub for an individual comic run or manga volume. This page aggregates all metadata, reading progress, and file management for a specific series into one beautiful layout.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/series_page_complete.png?raw=true" width="500" alt="Series page complete" />
  <br>
  <strong>A series page showing a series that currently has all available issues.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/series_page_incomplete.png?raw=true" width="500" alt="Series page incomplete" />
  <br>
  <strong>A series page showing a series that currently has all available issues.</strong>
</p>

* **Hero Banner & Synopsis:** A premium, visually striking header displaying high-resolution cover art, publisher logos, release years, and a full story synopsis pulled directly from ComicVine.
* **Interactive Metadata Badges:** View detailed credits including Writers, Artists, Characters, Teams, Locations, Genres, and Story Arcs. Every badge is a clickable link that instantly filters your entire library for connected issues and crossovers!
* **ComicVine Button:** A button that will take users directly to the series page on ComicVine.
* **"Read Next" Prompts:** A smart action button that instantly opens the web reader to your exact saved page on the next unread issue in the run.
* **Issue Grid & List Modes:** Toggle between a visual cover grid or a condensed list view to easily navigate massive, 100+ issue runs.
* **Individual Progress Tracking:** Every issue displays its own distinct status (Unread, In Progress with a visual progress bar, or Read). 
* **Bulk Actions:** Effortlessly manage your collection with one-click buttons to "Mark All as Read," "Refresh Metadata," or delete specific files right from the browser.
* **Missing Issue Detection:** Visually highlights gaps in your collection (e.g., if you have issues #1 and #3, it flags #2 as missing). Click "Request Missing" to queue them all up at once.
* **Sorting Options:** Sort issues sequentially (Issue # 1 to # 100) or reverse chronological (newest releases first) for ongoing weekly pulls.
* **Offline Downloading:** Admins can grant users permission to download raw .cbz files directly from the browser for offline reading in third-party apps.

### Web Reader
A completely custom, zero-friction reading experience built natively into the browser. No external apps required.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/reader_page.png?raw=true" width="500" alt="Reader page" />
  <br>
  <strong>Reader page and controls.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/reader_page_2.png?raw=true" width="500" alt="Reader page settings" />
  <br>
  <strong>Reader page settings.</strong>
</p>

* **Universal Format Support:** Native, blazing-fast extraction and rendering for `.cbz`, `.epub` archives, and will convert `.cbr` automatically to `.cbz`.
* **Reading Directions:** One-click toggles for Left-to-Right (Standard Comics), Right-to-Left (Manga), and continuous Vertical Scrolling (Webtoons).
* **Dynamic Page Layouts:** Single Page, Double Page, or "Double Page (No Cover)" to preserve correct spread alignments.
  * Adjust the gutter gap between 2-page spreads (Seamless, Small, Large).
  * Auto-Fit toggles: Fit to Width, Fit to Height, Screen, or Original Resolution.
* **Smart Preloading:** Silently caches the next several pages in the background so you never experience loading spinners while reading.
* **Control Schemes:** Fully mapped keyboard shortcuts for desktop readers (Arrow keys, Spacebar, F to Fullscreen), and intuitive tap/swipe zones for mobile and tablet users.
* **Live Image Adjustments:** Adjust brightness and contrast overlays independently of your device settings for late-night reading sessions.

### External Readers & OPDS Support
Omnibus features a native OPDS 1.2 server with the **Page Streaming Extension (PSE)**, allowing you to read your server's library directly in your favorite mobile and tablet apps without downloading the entire file first.

**Supported OPDS Apps:**
* **iOS / iPadOS:** Panels, Paperback, Chunky
* **Android:** Mihon, Tachiyomi, Moon+ Reader

**How to Connect:**
For security, external apps do not use your main account password. 
1. Log into your Omnibus web dashboard and navigate to your **Profile**.
2. Under **Account Security**, click **Manage API Keys**.
3. Generate a new key for your specific device (e.g., "Panels on iPad").
4. In your external reading app, add a new OPDS catalog:
   * **URL:** `http://<your-omnibus-ip>:3000/api/opds`
   * **Username:** Your Omnibus username
   * **Password:** The API Key you just generated

### Native e-Ink Sync (KOReader)
Omnibus acts as a master "save state" for your physical e-ink devices (Kobo, Kindle, Pocketbook). Using our custom KOReader sync endpoints, your eReader will automatically ping Omnibus every time you turn a page, and you can view your real-time progress right on your Omnibus Profile!

**How to Configure KOReader:**
1. Connect your eReader to Wi-Fi and open the top KOReader menu.
2. Navigate to **Settings > Progress Sync > Custom sync server**.
3. Enter your Omnibus URL: `http://<your-omnibus-ip>:3000/api/koreader`
4. Tap **Register / Login** and use your Omnibus **Username** and an **Omnibus API Key** (generated from your Profile) as the password.
5. **Crucial Step:** Go to **Progress Sync > Document matching method** and select **Path**. (This ensures Omnibus can perfectly map your device's progress back to your web library).

### Reading Lists
Perfect for navigating the complex web of massive comic book crossover events or creating your own curated reading orders.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/reading_lists.png?raw=true" width="500" alt="Reading lists page" />
  <br>
  <strong>Reading lists page showing 2 story arcs added.</strong>
</p>

* **Auto-Build Story Arcs:** Input a ComicVine Event ID (e.g., Marvel Civil War, Secret Wars, Flashpoint), and Omnibus will instantly generate the complete official reading order and automatically link the physical files you already own!
* **Bulk Missing Requests:** With one click, ask Omnibus to track down and download every issue you are missing from a massive crossover event.
* **Manual Drag-and-Drop:** Easily reorder issues within your lists with a simple drag-and-drop interface.
* **Dynamic Smart Lists:** Create lists that automatically populate based on tags, characters, or publishers.
* **Global vs Private Lists:** Admins can publish reading lists globally for all users, while users can curate private collections.
* **AniList & MyAnimeList (MAL):** Enter your public username to fetch your Manga tracking lists (Reading, Completed, Plan to Read). Omnibus will bundle your downloaded volumes into unified reading orders.
* **CSV Imports (LOCG / Goodreads):** Export your pull list or collection from League of Comic Geeks (LOCG) or Goodreads as a `.csv` file. Omnibus will parse the rows, fuzzy-match the series names and issue numbers to your local files, and generate a customized reading order.
* **Auto-Request Missing:** During any import, you can toggle Omnibus to automatically push missing issues or volumes directly to your download queue!

### User Profile & Preferences
A personalized space for each user on your server to manage their identity, track their unique reading habits, and customize their Omnibus experience to fit their workflow.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/profile_1.png?raw=true" width="500" alt="User profile page" />
  <br>
  <strong>Users profile page showing customizable header and avatar.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/profile_2.png?raw=true" width="500" alt="User profile page" />
  <br>
  <strong>Users profile page reading progress cards.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/profile_3.png?raw=true" width="500" alt="User profile page" />
  <br>
  <strong>Users profile page showing recent request history.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/profile_header.png?raw=true" width="500" alt="User profile page" />
  <br>
  <strong>Users profile menu from header where you can log out or change password.</strong>
</p>

* **Personal Identity:** Customize your account by uploading a unique profile avatar and a custom hero banner for your user dashboard.
* **Reading Statistics:** Track your all-time reading habits. View your total issues read, estimated pages turned, and your most-read publishers or genres.
* **UI Customization:** Set your own personal theme preferences (Dark mode, Light mode, or System default) and UI accent colors. These settings are tied to your account and persist across any device you log into.
* **Default Reader Settings:** Save your preferred Web Reader behaviors (e.g., always default to "Fit to Width" or default to "Right-to-Left" for manga libraries) so you never have to adjust settings when starting a new book.
* **Account Security:** Safely update your password and view or revoke active login sessions across your different devices.
* **Personal API Keys:** Generate secure, user-specific API tokens to integrate your Omnibus reading progress with third-party trackers (like MyAnimeList, AniList, or custom scripts) without giving out Admin access.
* **Theme Customization:** Toggle Dark/Light modes, adjust UI accent colors, and tailor the app to your visual preferences.

### Settings & Administration
Complete, granular control over your instance, your users, and your underlying automation.

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/admin_1.png?raw=true" width="500" alt="Admin page" />
  <br>
  <strong>Admin page showing data cards and configuration pages.</strong>
</p>

<p align="center">
  <img src="https://github.com/hankscafe/omnibus/blob/main/docs/images/admin_2.png?raw=true" width="500" alt="Admin page" />
  <br>
  <strong>Admin page showing active downloads and request management sections.</strong>
</p> 

* **High-Performance Architecture:** Built to handle massive terabyte-scale libraries. Features an optimized OPDS feed, asynchronous streaming cipher engines for backups, and B-Tree indexed database lookups.
* **Download Client Integration:** Connects seamlessly with qBittorrent, Deluge, SABnzbd, and NZBGet. Supports complex Docker remote-path mapping to ensure files move perfectly between containers.
* **3rd-Party File Hosters:** Native support for bypassing landing pages and downloading directly from MediaFire, Mega, Pixeldrain, Rootz, Vikingfile, and Terabox. Supports injecting premium API keys/session cookies to bypass bandwidth limits.
* **FlareSolverr Integration:** Route requests through a FlareSolverr container to seamlessly bypass Cloudflare protection (403 Forbidden errors) on sites like GetComics.
* **Smart Matcher:** An AI-assisted tool that scans your "Unmatched" folders, queries ComicVine, and suggests the correct metadata linkage so you can clean up messy archives in seconds.
* **Deep Diagnostics Engine:**
  * Ghost Records: Find and purge database entries pointing to files you deleted outside of Omnibus.
  * Orphaned Files: Find comic files sitting on your hard drive that Omnibus hasn't indexed, saving you wasted disk space.
  * Archive Integrity: Scan your .cbz files to detect corrupted or incomplete zip archives.
* **Storage Analytics:** A beautiful visual dashboard breaking down your storage usage by publisher, tracking user engagement, and highlighting "Inactive Series" that you might want to delete to free up space.
* **Indexer Support:** Plug in Prowlarr or Jackett to search dozens of trackers simultaneously, and use torznab IDs to prevent unwanted results.
* **Queue & History Management:** View active, pending, paused, and completed downloads with real-time progress bars, speeds, and ETA.
* **Automated Post-Processing:** Once a comic is downloaded, Omnibus automatically:
  1. Extracts the file (if necessary).
  2. Renames the file to your customized standard format.
  3. Moves it to the correct publisher/series directory on your NAS.
  4. Triggers a local library scan to make it instantly readable.
* **User & Role Management:** Create independent accounts for friends and family so everyone has their own reading progress.
  * Admin or User roles
  * Users can be assigned auto-approval permission and download permission
* **Library Path Mapping:** Omnibus supports multiple libraries to easily map multiple root directories from your NAS (e.g., separate folders for `/comics`, `/manga`, and `/magazines`).
* **Alerts & Notifications:**
  * **Discord Webhooks:** Configure webhooks to send server alerts to your Discord channels when comics are requested, approved, or finish downloading.
  * **SMTP Email Notifications:** Configure an SMTP server to send beautiful, customizable HTML emails for account approvals, password resets, request completions, and a Weekly Digest of newly added comics.
* **API & Service Configuration:** Securely plug in your ComicVine API keys, Indexer credentials, and Download Client details.
* [**External API Integrations:**](https://github.com/hankscafe/omnibus/blob/main/docs/API.md) Generate an API key to allow external applications (like Discord Bots or Dashboards) to fetch stats and interact with Omnibus securely.
* **Safe Configuration:** Dual-guard unsaved changes protection to ensure admins never accidentally lose their configuration progress.
* **Scheduled Tasks (Cron):** Configure how often Omnibus should scan your disk for new files, refresh metadata, or check indexers for missing requested issues.
* **Live System Logs:** A built-in log viewer to easily troubleshoot API limits, failed downloads, or matching errors.

---

## Additional Screenshots

| | | |
|:---:|:---:|:---:|
| [![Analytics page showing data cards](https://github.com/hankscafe/omnibus/blob/main/docs/images/analytics_1.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/analytics_1.png?raw=true) | [![Analytics page showing purge option for unread series](https://github.com/hankscafe/omnibus/blob/main/docs/images/analytics_2.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/analytics_2.png?raw=true) | [![Requests awaiting approval](https://github.com/hankscafe/omnibus/blob/main/docs/images/approvals.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/approvals.png?raw=true) |
| [![Library diagnostics page](https://github.com/hankscafe/omnibus/blob/main/docs/images/diagnostics.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/diagnostics.png?raw=true) | [![Issue reports page](https://github.com/hankscafe/omnibus/blob/main/docs/images/issue_reports_1.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/issue_reports_1.png?raw=true) | [![Issue reports admin response](https://github.com/hankscafe/omnibus/blob/main/docs/images/issue_reports_2.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/issue_reports_2.png?raw=true) |
| [![Issue reports resolution](https://github.com/hankscafe/omnibus/blob/main/docs/images/issue_reports_3.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/issue_reports_3.png?raw=true) | [![My Requests page](https://github.com/hankscafe/omnibus/blob/main/docs/images/my_requests.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/my_requests.png?raw=true) | [![Smart Matcher page](https://github.com/hankscafe/omnibus/blob/main/docs/images/smart_matcher.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/smart_matcher.png?raw=true) |
| [![Storage Deep Dive page](https://github.com/hankscafe/omnibus/blob/main/docs/images/storage_deep_dive.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/storage_deep_dive.png?raw=true) | [![System Logs live terminal](https://github.com/hankscafe/omnibus/blob/main/docs/images/system_logs_1.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/system_logs_1.png?raw=true) | [![System Logs page](https://github.com/hankscafe/omnibus/blob/main/docs/images/system_logs_2.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/system_logs_2.png?raw=true) |
| [![User Management page](https://github.com/hankscafe/omnibus/blob/main/docs/images/users.png?raw=true)](https://github.com/hankscafe/omnibus/blob/main/docs/images/users.png?raw=true) | | |

---

## Installation (Docker)

Omnibus is built to be deployed via Docker. Because it utilizes a serverless SQLite engine through Prisma, **all necessary database files and dependencies are bundled directly into the image.** There are no external database containers required!

1. Save the following as `docker-compose.yml`:

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
      
      # REQUIRED: Set to your Cloudflare Tunnel domain (e.g., [https://omnibus.mydomain.com](https://omnibus.mydomain.com))
      # or your NAS IP (e.g., [http://192.168.1.100:3000](http://192.168.1.100:3000))
      - NEXTAUTH_URL=[http://192.168.1.100:3000](http://192.168.1.100:3000)
      
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
---

2. Run `docker-compose up -d`.
3. Open your browser and navigate to your `NEXTAUTH_URL` to access the Setup Wizard!

## Acknowledgements

Omnibus stands on the shoulders of giants. This project was heavily inspired by and built with immense respect for the developers of the following incredible self-hosted applications:

* **[Kavita](https://www.kavitareader.com/):** For setting the gold standard in self-hosted reading and library management.
* **[Komga](https://komga.org/):** For their incredible work in the digital comic management space.
* **[Kapowarr](https://github.com/Casvt/Kapowarr):** For pioneering modern comic book request and download automation.
* **[Mylar3](https://github.com/mylar3/mylar3):** The absolute titan of comic tracking and downloading that paved the way.
* **[ReadMeABook](https://github.com/kikootwo/ReadMeABook):** For the beautiful UI/UX inspiration and demonstrating what a modern web reader can look like.
* **[ComicVine](https://comicvine.gamespot.com/):** For providing the API and metadata backbone that keeps our digital collections accurate and beautiful.

---

## Contributors
- **Gemini** - AI Technical Collaborator & Project Advisor
- **Claude (Anthropic)** - For extensive AI assistance with code review, debugging, and refactoring.