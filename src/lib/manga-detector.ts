// src/lib/manga-detector.ts
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
import { prisma } from './db';

// Default Internal Publisher Dictionary Fallbacks
const DEFAULT_MANGA_PUBLISHERS = [
    "viz media", "kodansha", "yen press", "seven seas", "shueisha", 
    "shogakukan", "tokyopop", "dark horse manga", "vertical", 
    "ghost ship", "denpa", "fakku", "j-novel club", "sublime", 
    "kuma", "ize press", "square enix", "hakusensha", "lezhin"
];

const DEFAULT_WESTERN_PUBLISHERS = [
    "marvel", "dc comics", "image comics", "idw publishing", 
    "dynamite", "boom! studios", "valiant", "archie", 
    "oni press", "titan comics", "vault comics", "awa studios", "humanoids", "2000 ad", "zenescope"
];

const MANGA_CONCEPTS = [
    "manga", "shonen", "seinen", "shojo", "josei", 
    "manhwa", "manhua", "webtoon", "tankobon", "doujinshi"
];

// --- NEW: In-Memory Cache to prevent N+1 DB queries during mass library scans ---
let cachedSettings: { manga: string[], western: string[] } | null = null;
let cacheTimestamp = 0;

async function getDetectorSettings() {
    // Return cache if it is less than 5 minutes old
    if (cachedSettings && Date.now() - cacheTimestamp < 5 * 60 * 1000) {
        return cachedSettings;
    }

    const settings = await prisma.systemSetting.findMany({
        where: { key: { in: ['manga_publishers', 'western_publishers'] } }
    });
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
    
    cachedSettings = {
        manga: config.manga_publishers 
            ? config.manga_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_MANGA_PUBLISHERS,
        western: config.western_publishers
            ? config.western_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_WESTERN_PUBLISHERS
    };
    cacheTimestamp = Date.now();

    return cachedSettings;
}

export async function detectManga(
    comicVineData: any, 
    filePath: string | null = null
): Promise<boolean> {
    
    // Fetch settings (will hit RAM instantly 99% of the time)
    const { manga: mangaPublishers, western: westernPublishers } = await getDetectorSettings();

    // --------------------------------------------------------
    // WATERFALL STEP 1: Check Publisher
    // --------------------------------------------------------
    if (comicVineData?.publisher?.name) {
        const publisher = comicVineData.publisher.name.toLowerCase();
        if (mangaPublishers.some((mp: string) => publisher.includes(mp))) {
            Logger.log(`[Manga Engine] Identified via Publisher: ${publisher}`, 'info');
            return true;
        }
    }

    // --------------------------------------------------------
    // WATERFALL STEP 2: Check ComicVine Concepts
    // --------------------------------------------------------
    if (comicVineData?.concepts && Array.isArray(comicVineData.concepts)) {
        const hasMangaConcept = comicVineData.concepts.some((concept: any) => 
            MANGA_CONCEPTS.includes(concept.name?.toLowerCase())
        );
        if (hasMangaConcept) {
            Logger.log(`[Manga Engine] Identified via ComicVine Concepts`, 'info');
            return true;
        }
    }

    // --------------------------------------------------------
    // WATERFALL STEP 2.5: Western Publisher Hard-Bypass
    // --------------------------------------------------------
    if (comicVineData?.publisher?.name) {
        const publisher = comicVineData.publisher.name.toLowerCase();
        if (westernPublishers.some((wp: string) => publisher.includes(wp))) {
            Logger.log(`[Manga Engine] Bypassing AniList due to Western Publisher: ${publisher}`, 'info');
            
            if (filePath && fs.existsSync(filePath)) {
                const ext = path.extname(filePath).toLowerCase();
                if (ext === '.cbz' || ext === '.zip') {
                    try {
                        const zip = new AdmZip(filePath);
                        const xmlEntry = zip.getEntry("ComicInfo.xml");
                        if (xmlEntry) {
                            const xmlString = xmlEntry.getData().toString("utf8");
                            const parser = new XMLParser();
                            const jsonObj = parser.parse(xmlString);
                            const mangaTag = jsonObj?.ComicInfo?.Manga;
                            if (mangaTag === 'Yes' || mangaTag === 'YesAndRightToLeft') {
                                Logger.log(`[Manga Engine] Override: Identified via ComicInfo.xml`, 'info');
                                return true;
                            }
                        }
                    } catch (e) {}
                }
            }
            return false; 
        }
    }

    // --------------------------------------------------------
    // WATERFALL STEP 3: AniList API Cross-Reference
    // --------------------------------------------------------
    if (comicVineData?.name) {
        try {
            const releaseYear = parseInt(comicVineData.year) || parseInt(comicVineData.start_year) || 0;
            const isAniListMatch = await checkAniList(comicVineData.name, releaseYear);
            
            if (isAniListMatch) {
                Logger.log(`[Manga Engine] Identified via AniList API Match`, 'info');
                return true;
            }
        } catch (e) {
            Logger.log(`[Manga Engine] AniList check failed: ${getErrorMessage(e)}`, 'error');
        }
    }

    // --------------------------------------------------------
    // WATERFALL STEP 4: ComicInfo.xml Check
    // --------------------------------------------------------
    if (filePath && fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.cbz' || ext === '.zip') {
            try {
                const zip = new AdmZip(filePath);
                const xmlEntry = zip.getEntry("ComicInfo.xml");
                if (xmlEntry) {
                    const xmlString = xmlEntry.getData().toString("utf8");
                    const parser = new XMLParser();
                    const jsonObj = parser.parse(xmlString);
                    if (jsonObj?.ComicInfo?.Manga === 'Yes' || jsonObj?.ComicInfo?.Manga === 'YesAndRightToLeft') {
                        return true;
                    }
                }
            } catch (e) {}
        }
    }

    return false;
}

/**
 * Helper Function: Queries AniList GraphQL API with Fuzzy Year Logic
 */
async function checkAniList(title: string, releaseYear: number): Promise<boolean> {
    const query = `
        query ($search: String) {
            Page(page: 1, perPage: 3) {
                media(search: $search, type: MANGA) {
                    title { romaji english }
                    startDate { year }
                    format
                }
            }
        }
    `;

    const response = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { search: title } })
    });

    if (!response.ok) return false;

    const data = await response.json();
    const mediaResults = data?.data?.Page?.media || [];

    const searchTitle = title.toLowerCase().trim();

    for (const media of mediaResults) {
        const engTitle = media.title?.english?.toLowerCase().trim() || "";
        const romajiTitle = media.title?.romaji?.toLowerCase().trim() || "";

        if (searchTitle === engTitle || searchTitle === romajiTitle) {
            if (releaseYear > 0 && media.startDate?.year) {
                const yearDiff = Math.abs(releaseYear - media.startDate.year);
                if (yearDiff > 4) {
                    Logger.log(`[Manga Engine] AniList match rejected due to Year Mismatch (${releaseYear} vs JP ${media.startDate.year})`, 'info');
                    continue; 
                }
            }
            return true;
        }
    }

    return false;
}