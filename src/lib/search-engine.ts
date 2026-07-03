// src/lib/search-engine.ts
import { prisma } from '@/lib/db';

export async function getCustomAcronyms(): Promise<Record<string, string>> {
    const acronyms = await prisma.searchAcronym.findMany();
    const defaults = { 'tmnt': 'teenage mutant ninja turtles', 'asm': 'amazing spider-man', 'f4': 'fantastic four', 'jla': 'justice league of america' };
    if (acronyms.length === 0) return defaults;
    const acMap: Record<string, string> = {};
    acronyms.forEach((a: any) => { if (a.key && a.value) acMap[a.key.toLowerCase()] = a.value.toLowerCase(); });
    return acMap;
}

// Drops a trailing descriptive subtitle from a single-issue request name:
// "Batman: Gargoyle of Gotham #1: Book One" -> "Batman: Gargoyle of Gotham #1".
// Only applies when an issue marker (#/issue/chapter + number) is present, so a genuine TPB request
// like "Batman Book One" is left intact. Both the query generator and the GetComics relevance filter
// must derive their "core name" through this, otherwise a subtitle keyword such as "Book"/"Volume"
// trips TPB/omnibus detection and the subtitle words get enforced as required title words — rejecting
// every real single-issue file, since the uploader never includes the subtitle. (-? keeps negative
// issue numbers like "Batman #-1" recognized as single issues.)
export function stripIssueSubtitle(name: string): string {
    if (!/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+/i.test(name)) return name;
    const splitMatch = name.match(/^(.*?(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+(?:\.\d+)?[a-zA-Z]?)\s*[:\-]\s*.*$/i);
    return splitMatch ? splitMatch[1].trim() : name;
}

// Strips a trailing comic/archive file extension so a download FILENAME (e.g. a retry's
// activeDownloadName "Wolverine #3 (2024).cbz") doesn't leak "cbz" into the generated queries or the
// relevance filter.
export function stripFileExtension(name: string): string {
    return name.replace(/\.(cbz|cbr|cb7|cbt|zip|rar|7z|pdf|epub)$/i, '').trim();
}

// Normalizes a request name for searching: drops a trailing file extension AND a trailing subtitle.
// "Wolverine #3 (2024).cbz" -> "Wolverine #3 (2024)"; "Batman #1: Book One" -> "Batman #1".
export function normalizeRequestName(name: string): string {
    return stripIssueSubtitle(stripFileExtension(name));
}

export function generateSearchQueries(name: string, year: string, acronyms: Record<string, string>, isManga: boolean = false, prioritizePacks: boolean = false, usePacks: boolean = true): string[] {
    const searchName = normalizeRequestName(name);

    const primaryQueries = new Set<string>(); 
    const secondaryQueries = new Set<string>();

    const baseName = searchName.replace(/[#]/g, '').trim();
    const noPossessive = baseName.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
    const broadClean = noPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    let mainPart = searchName;
    let subtitle = "";
    let hasSubtitle = false;

    if (searchName.includes(' - ')) {
        const parts = searchName.split(' - ');
        mainPart = parts[0].trim();
        subtitle = parts.slice(1).join(' - ').trim();
        hasSubtitle = true;
    } else if (searchName.includes(': ')) {
        const parts = searchName.split(': ');
        mainPart = parts[0].trim();
        subtitle = parts.slice(1).join(': ').trim();
        hasSubtitle = true;
    }

    if (hasSubtitle) {
        const mainPartClean = mainPart.replace(/[#]/g, '').trim();
        const mainNoPossessive = mainPartClean.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
        const mainBroadClean = mainNoPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (mainBroadClean.length > 2) {
            if (year) primaryQueries.add(`${mainBroadClean} ${year}`.trim());
            primaryQueries.add(mainBroadClean);
            
            let mainExpanded = mainBroadClean;
            for (const [ac, full] of Object.entries(acronyms)) {
                const regex = new RegExp(`\\b${ac}\\b`, 'gi');
                mainExpanded = mainExpanded.replace(regex, full);
            }
            if (mainExpanded.toLowerCase() !== mainBroadClean.toLowerCase()) {
                if (year) primaryQueries.add(`${mainExpanded} ${year}`.trim());
                primaryQueries.add(mainExpanded);
            }
        }
    }

    if (year) secondaryQueries.add(`${baseName} ${year}`.trim());
    secondaryQueries.add(baseName);
    if (year) secondaryQueries.add(`${broadClean} ${year}`.trim());
    secondaryQueries.add(broadClean);

    if (baseName.match(/[\/:\&]/)) {
        const dashed = baseName.replace(/[\/:\&]/g, ' - ').replace(/\s+/g, ' ').trim();
        if (year) secondaryQueries.add(`${dashed} ${year}`.trim());
        secondaryQueries.add(dashed);
    }

    let expanded = broadClean;
    for (const [ac, full] of Object.entries(acronyms)) {
        const regex = new RegExp(`\\b${ac}\\b`, 'gi');
        expanded = expanded.replace(regex, full);
    }
    if (expanded.toLowerCase() !== broadClean.toLowerCase()) {
        if (year) secondaryQueries.add(`${expanded} ${year}`.trim());
        secondaryQueries.add(expanded);
    }

    // --- PACK GENERATOR ---
    const packQueries = new Set<string>();
    
    if (usePacks) {
        const seriesOnlyName = broadClean.replace(/\s\d+(?:\.\d+)?$/, '').trim();
        if (seriesOnlyName !== broadClean && seriesOnlyName.length > 2) {
            packQueries.add(seriesOnlyName);
            packQueries.add(`${seriesOnlyName} collection`);
            packQueries.add(`${seriesOnlyName} story arc`);
            packQueries.add(`${seriesOnlyName} pack`);
        } else if (seriesOnlyName.length > 2) {
            packQueries.add(`${seriesOnlyName} collection`);
            packQueries.add(`${seriesOnlyName} story arc`);
            packQueries.add(`${seriesOnlyName} pack`);
        }
    }

    // The bare main-title queries (e.g. "X Men" / "X Men 2026" from a colon-split "X-Men: Outback #1")
    // live in primaryQueries; the full, specific name variants (series + subtitle + issue number) live in
    // secondaryQueries. Search the SPECIFIC variants FIRST so a series whose name legitimately contains a
    // colon/dash isn't immediately matched against its entire line by an over-broad title-only query —
    // which also drops the issue number, disabling the indexer's issue filter and letting any issue win.
    // The broad title query is retained as a fallback for when the specific variants find nothing.
    if (prioritizePacks && usePacks) {
        return [...Array.from(packQueries), ...Array.from(secondaryQueries), ...Array.from(primaryQueries)];
    }

    return [...Array.from(secondaryQueries), ...Array.from(primaryQueries), ...Array.from(packQueries)];
}