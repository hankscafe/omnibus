# 📚 Omnibus

<p align="center">
  <img src="docs/images/banner.png" alt="Omnibus Banner" />
</p>

**Omnibus** is the ultimate all-in-one, self-hosted web application built specifically for the comic book and manga community. It seamlessly bridges the gap between discovering, requesting, downloading, managing, and reading your digital collection. 

Built with a modern, lightning-fast tech stack (Next.js 15, Tailwind v4, Prisma, and a serverless SQLite engine), Omnibus is designed to be lightweight, performant, and responsive across all your devices. Whether you are managing a massive archive of `.cbz` and `.cbr` files, hunting down missing issues of your favorite run, or just looking for a clean, distraction-free web reader, Omnibus brings your entire comic universe under one roof.

---

## 📑 Table of Contents
- [About Omnibus](#about-omnibus)
- [Features & Navigation](#features--navigation)
  - [🏠 Dashboard](#-dashboard)
  - [📚 The Library](#-the-library)
  - [📖 Web Reader](#-web-reader)
  - [🔍 Discovery & Search](#-discovery--search)
  - [⬇️ Requests & Downloads](#️-requests--downloads)
  - [📋 Reading Lists](#-reading-lists)
  - [⚙️ Settings & Administration](#️-settings--administration)
- [🚀 Installation (Docker)](#-installation-docker)
- [🙏 Acknowledgements](#-acknowledgements)

---

## Features & Navigation

### 🏠 Dashboard
The Dashboard is the personalized nerve center of your collection. It dynamically updates based on the logged-in user to provide a tailored snapshot of their reading journey.
![Dashboard Screenshot](docs/images/dashboard-screenshot.png) * **"Continue Reading" Shelf:** A dynamically updated carousel that tracks your exact page in ongoing issues. Jump back into the action with a single click.
* **"Up Next" Suggestions:** Once you finish an issue, Omnibus automatically queues up the next chronological issue in that series so you never lose your momentum.
* **Recently Added:** Highlights the newest volumes and issues that have been successfully imported and processed into the library over the last 30 days.
* **Global Server Statistics:** Real-time data visualization showing your total series, total issues, distinct publishers, and overall storage footprint.
* **Active Queue Widget:** A quick-glance view of your current download clients, showing what is actively pulling in without needing to leave the dashboard.

### 📚 The Library
A meticulously organized, highly performant view of your physical files, built to handle massive, multi-terabyte collections smoothly.
![Library Screenshot](docs/images/library-screenshot.png) * **Infinite Scrolling & Virtualization:** Browse thousands of high-resolution covers seamlessly without lagging your browser or consuming excess RAM.
* **Advanced Metadata Parsing:** Automatically extracts embedded `ComicInfo.xml` and ComicRack metadata to accurately display titles, volume numbers, writers, artists, and summaries.
* **Series vs. Issue Hierarchy:** Automatically groups individual loose issues into their proper Series or Volume folders for a clean, uncluttered browsing experience.
* **Deep Filtering & Sorting:** * Filter your collection by Publisher (Marvel, DC, Image, etc.), Genre, Format (Comic vs. Manga vs. Magazine), and Status (Completed/Ongoing).
  * Filter by User Reading Status (Unread, In Progress, Read).
  * Sort by Recently Added, Release Date, Alphabetical, or Last Read.
* **Smart Progress Badging:** Visual overlay indicators on covers to instantly show reading progress bars and how many unread issues remain in a series.
* **Manual Metadata Editing:** Override automatic metadata with custom titles, descriptions, and cover image uploads if you prefer your own organization.

### 📖 Web Reader
A completely custom, zero-friction reading experience built natively into the browser. No external apps required.
![Reader Screenshot](docs/images/reader-screenshot.png) * **Universal Format Support:** Native, blazing-fast extraction and rendering for `.cbz`, `.cbr`, `.zip`, `.rar`, and `.epub` archives.
* **Reading Directions:** One-click toggles for Left-to-Right (Standard Comics), Right-to-Left (Manga), and continuous Vertical Scrolling (Webtoons).
* **Dynamic Page Layouts:** * Choose between Single Page or Double Page spreads (perfect for splash pages).
  * Auto-Fit toggles: Fit to Width, Fit to Height, or Original Resolution.
* **Smart Preloading:** Silently caches the next several pages in the background so you never experience loading spinners while reading.
* **Control Schemes:** Fully mapped keyboard shortcuts for desktop readers (Arrow keys, Spacebar, F to Fullscreen), and intuitive tap/swipe zones for mobile and tablet users.
* **Brightness & Contrast Overlay:** Adjust the brightness of the reader independently of your device settings for late-night reading sessions.

### 🔍 Discovery & Search
Integrated directly with powerful external APIs to help you identify and find the missing pieces of your collection.
![Discovery Screenshot](docs/images/discovery-screenshot.png) * **Native ComicVine Integration:** Search the definitive comic database to pull highly accurate metadata, original release dates, character appearances, and high-res variant covers.
* **Smart Series Matching:** Easily distinguish between different volumes and runs with the same name (e.g., separating *Batman (1940)* from *Batman (2011)*).
* **Unified Global Search:** Instantly search across both your local physical files and the external ComicVine database simultaneously from one search bar.
* **"Missing Issue" Detection:** Omnibus compares your local files against the ComicVine API to visually highlight which issues you are missing to complete a run.
* **One-Click Requests:** Found a missing issue or an entire story arc? Click "Request" to instantly send it to your automated download queue.

### ⬇️ Requests & Downloads
Your automated librarian. Tell Omnibus what you want, and it handles the complex world of tracking, downloading, and organizing.
![Downloads Screenshot](docs/images/downloads-screenshot.png) * **Download Client Integration:** Connects seamlessly with your favorite Torrent clients (qBittorrent, Transmission) and USENET clients (SABnzbd, NZBGet) behind the scenes.
* **Indexer Support:** Plug in Prowlarr or Jackett to search dozens of trackers simultaneously.
* **Queue & History Management:** View active, pending, paused, and completed downloads with real-time progress bars, speeds, and ETA.
* **Automated Post-Processing:** Once a comic is downloaded, Omnibus automatically:
  1. Extracts the file (if necessary).
  2. Renames the file to your customized standard format.
  3. Moves it to the correct publisher/series directory on your NAS.
  4. Triggers a local library scan to make it instantly readable.
* **Release Profiles & Quality Gates:** Specify your preferred file types (e.g., prefer `.cbz`, ignore `.pdf`) and preferred release groups.
* **Upcoming Release Tracking:** Monitors your requested ongoing series for new weekly Wednesday releases and automatically grabs them as they are uploaded.

### 📋 Reading Lists
Perfect for navigating the complex web of massive comic book crossover events or creating your own curated reading orders.
![Reading Lists Screenshot](docs/images/reading-lists-screenshot.png) * **Cross-Series Curations:** Create custom lists that span multiple series, volumes, and publishers seamlessly.
* **Event Tracking:** Build and follow complex chronological reading orders for major events (e.g., *Infinity Gauntlet*, *Secret Wars*, *Crisis on Infinite Earths*) without having to jump back and forth between folders.
* **Manual Drag-and-Drop:** Easily reorder issues within your lists with a simple drag-and-drop interface.
* **Dynamic Smart Lists:** Create lists that automatically populate based on tags, characters, or publishers.
* **Shareable Lists:** *(Coming Soon)* Import or export reading lists with the wider Omnibus community.

### ⚙️ Settings & Administration
Complete, granular control over your instance, your users, and your underlying automation.
![Settings Screenshot](docs/images/settings-screenshot.png) * **User & Role Management:** * Create independent accounts for friends and family so everyone has their own reading progress.
  * Restrict access to certain libraries (e.g., hiding mature content from younger users).
  * Assign Admin, Contributor, or Reader roles.
* **Library Path Mapping:** Easily map multiple root directories from your NAS (e.g., separate folders for `/comics`, `/manga`, and `/magazines`).
* **API & Service Configuration:** Securely plug in your ComicVine API keys, Indexer credentials, and Download Client details.
* **Scheduled Tasks (Cron):** Configure how often Omnibus should scan your disk for new files, refresh metadata, or check indexers for missing requested issues.
* **System Logs:** A built-in log viewer to easily troubleshoot API limits, failed downloads, or matching errors.
* **Theme Customization:** Toggle Dark/Light modes, adjust UI accent colors, and tailor the app to your visual preferences.

---

## 🚀 Installation (Docker)

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
    environment:
      # REQUIRED: Change to your NAS IP or your domain (e.g., [https://omnibus.mydomain.com](https://omnibus.mydomain.com))
      - NEXTAUTH_URL=[http://192.168.1.100:3000](http://192.168.1.100:3000) 
      # REQUIRED: Generate a random string for security
      - NEXTAUTH_SECRET=super_secret_generated_key_123!
    volumes:
      # Map your local config folder to store the SQLite database securely on your NAS
      - /path/to/your/nas/config:/app/prisma
      # Map your comic/manga storage directories
      - /path/to/your/nas/comics:/comics
      - /path/to/your/nas/downloads:/downloads
```

2. Run `docker-compose up -d`.
3. Open your browser and navigate to your `NEXTAUTH_URL` to access the Setup Wizard!

---

## 🙏 Acknowledgements

Omnibus stands on the shoulders of giants. This project was heavily inspired by and built with immense respect for the developers of the following incredible self-hosted applications:

* **[Kavita](https://www.kavitareader.com/):** For setting the gold standard in self-hosted reading and library management.
* **[Komga](https://komga.org/):** For their incredible work in the digital comic management space.
* **[Kapowarr](https://github.com/Casvt/Kapowarr):** For pioneering modern comic book request and download automation.
* **[Mylar3](https://github.com/mylar3/mylar3):** The absolute titan of comic tracking and downloading that paved the way.
* **[ReadMeABook](https://github.com/kikootwo/ReadMeABook):** For the beautiful UI/UX inspiration and demonstrating what a modern web reader can look like.
* **[ComicVine](https://comicvine.gamespot.com/):** For providing the API and metadata backbone that keeps our digital collections accurate and beautiful.