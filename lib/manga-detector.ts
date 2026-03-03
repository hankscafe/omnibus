import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

// STEP 1: Internal Publisher Dictionary
const MANGA_PUBLISHERS = [
    "viz media", "kodansha", "yen press", "seven seas", "shueisha", 
    "shogakukan", "tokyopop", "dark horse manga", "vertical", 
    "ghost ship", "denpa", "fakku", "j-novel club", "sublime", 
    "kuma", "ize press", "square enix", "hakusensha", "lezhin"
];

// STEP 1.5: Strict Western Publisher Bypass
const WESTERN_PUBLISHERS = [
    "marvel", "dc comics", "image comics", "idw publishing", 
    "dynamite", "boom! studios", "valiant", "archie", 
    "oni press", "titan comics", "vault comics", "awa studios", "humanoids", "2000 ad", "zenescope"
];

// STEP 2: ComicVine Concepts Dictionary
const MANGA_CONCEPTS = [
    "manga", "shonen", "seinen", "shojo", "josei", 
    "manhwa", "manhua", "webtoon", "tankobon", "doujinshi"
];

export async function detectManga(
    comicVineData: any, 
    filePath: string | null = null
): Promise<boolean> {
    
    // --------------------------------------------------------
    // WATERFALL STEP 1: Check Publisher
    // --------------------------------------------------------
    if (comicVineData?.publisher?.name) {
        const publisher = comicVineData.publisher.name.toLowerCase();
        if (MANGA_PUBLISHERS.some(mp => publisher.includes(mp))) {
            console.log(`[Manga Engine] Identified via Publisher: ${publisher}`);
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
            console.log(`[Manga Engine] Identified via ComicVine Concepts`);
            return true;
        }
    }

    // --------------------------------------------------------
    // WATERFALL STEP 2.5: Western Publisher Hard-Bypass
    // --------------------------------------------------------
    if (comicVineData?.publisher?.name) {
        const publisher = comicVineData.publisher.name.toLowerCase();
        if (WESTERN_PUBLISHERS.some(wp => publisher.includes(wp))) {
            console.log(`[Manga Engine] Bypassing AniList due to Western Publisher: ${publisher}`);
            
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
                                console.log(`[Manga Engine] Override: Identified via ComicInfo.xml`);
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
    // WATERFALL STEP 3: AniList API Cross-Reference (NOW WITH YEAR)
    // --------------------------------------------------------
    if (comicVineData?.name) {
        try {
            // Extract year if provided by the caller
            const releaseYear = parseInt(comicVineData.year) || parseInt(comicVineData.start_year) || 0;
            const isAniListMatch = await checkAniList(comicVineData.name, releaseYear);
            
            if (isAniListMatch) {
                console.log(`[Manga Engine] Identified via AniList API Match`);
                return true;
            }
        } catch (e) {
            console.warn("[Manga Engine] AniList check failed.", e);
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
            // FUZZY YEAR CHECK: If we have a year, ensure it's within 4 years of the Japanese release
            if (releaseYear > 0 && media.startDate?.year) {
                const yearDiff = Math.abs(releaseYear - media.startDate.year);
                if (yearDiff > 4) {
                    console.log(`[Manga Engine] AniList match rejected due to Year Mismatch (${releaseYear} vs JP ${media.startDate.year})`);
                    continue; // Skip this result, year is too far off
                }
            }
            return true;
        }
    }

    return false;
}