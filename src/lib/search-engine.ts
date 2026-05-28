// src/lib/search-engine.ts
import axios from 'axios';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { getCustomHeaders } from './utils/headers';
import { getErrorMessage } from './utils/error';
import { Logger } from './logger';

export async function getCustomAcronyms(): Promise<Record<string, string>> {
    const acronyms = await prisma.searchAcronym.findMany();
    const defaults = { 'tmnt': 'teenage mutant ninja turtles', 'asm': 'amazing spider-man', 'f4': 'fantastic four', 'jla': 'justice league of america' };
    if (acronyms.length === 0) return defaults;
    const acMap: Record<string, string> = {};
    acronyms.forEach((a: any) => { if (a.key && a.value) acMap[a.key.toLowerCase()] = a.value.toLowerCase(); });
    return acMap;
}

export function generateSearchQueries(name: string, year: string, acronyms: Record<string, string>, isManga: boolean = false): string[] {
    let searchName = name;
    
    // --- SMART SUBTITLE SLICER ---
    // If this is a single issue (contains # or Issue), we aggressively strip the publisher's story-arc subtitle.
    // We do NOT strip subtitles from TPBs or Volumes, because they are often needed (e.g. "Batman: Hush").
    const isSingleIssue = /(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+/i.test(name);
    if (isSingleIssue) {
        const splitMatch = name.match(/^(.*?(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+(?:\.\d+)?[a-zA-Z]?)\s*[:\-]\s*(.*)$/i);
        if (splitMatch) {
            searchName = splitMatch[1].trim();
        }
    }

    const primaryQueries = new Set<string>(); 
    const secondaryQueries = new Set<string>();

    const baseName = searchName.replace(/[#]/g, '').trim();
    Logger.log(`[Search Engine Debug] Generating queries for Base Name: "${baseName}", Year: "${year}"`, 'debug');

    const noPossessive = baseName.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
    const broadClean = noPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    let mainPart = searchName;
    let subtitle = "";
    let hasSubtitle = false;

    // We only split here if it's a TPB that still has a subtitle, OR if the slicer didn't catch something.
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
        Logger.log(`[Search Engine Debug] Split detected. Main Part: "${mainPart}", Subtitle: "${subtitle}"`, 'debug');

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
                Logger.log(`[Search Engine Debug] Expanded acronym in Main Part: "${mainBroadClean}" -> "${mainExpanded}"`, 'debug');
                if (year) primaryQueries.add(`${mainExpanded} ${year}`.trim());
                primaryQueries.add(mainExpanded);
            }
        }
    }

    // Push full length names
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
        Logger.log(`[Search Engine Debug] Expanded Base Acronym: "${broadClean}" -> "${expanded}"`, 'debug');
        if (year) secondaryQueries.add(`${expanded} ${year}`.trim());
        secondaryQueries.add(expanded);
    }

    // NEW: Generate a "Series Only" fallback query to catch Bulk Packs/Collections
    const seriesOnlyName = broadClean.replace(/\s\d+(?:\.\d+)?$/, '').trim();
    if (seriesOnlyName !== broadClean && seriesOnlyName.length > 2) {
        secondaryQueries.add(seriesOnlyName);
        secondaryQueries.add(`${seriesOnlyName} collection`);
        secondaryQueries.add(`${seriesOnlyName} story arc`);
    }

    return [...Array.from(primaryQueries), ...Array.from(secondaryQueries)];
}

export const SearchEngine = {
    async performSmartSearch(query: string) {
        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        if (!config.prowlarr_url || !config.prowlarr_key) {
            throw new Error("Prowlarr not configured");
        }

        const indexerConfigs = await prisma.indexer.findMany();
        const customHeaders = await getCustomHeaders();
        const cleanUrl = config.prowlarr_url.replace(/\/$/, "");

        Logger.log(`[SearchEngine Debug] Hitting Prowlarr endpoint: ${cleanUrl}/api/v1/search with query: ${query}`, 'debug');

        const res = await axios.get(`${cleanUrl}/api/v1/search`, {
            params: { query, type: 'search' }, 
            headers: { 
                'X-Api-Key': config.prowlarr_key,
                ...customHeaders 
            },
            timeout: 30000
        });

        const results = res.data;

        if (!Array.isArray(results) || results.length === 0) {
            return { success: false, message: "No results found in Prowlarr" };
        }

        const scoredResults = results.map((release: any) => {
            const idxConfig = indexerConfigs.find(c => c.id === release.indexerId);
            const priority = idxConfig ? idxConfig.priority : 1; 
            const seedTime = idxConfig ? idxConfig.seedTime : 0; 

            const score = (priority * 1000000) + release.seeders;
            Logger.log(`[SearchEngine Debug] Scored release "${release.title}": Priority [${priority}] + Seeders [${release.seeders}] = Total Score: ${score}`, 'debug');

            return {
                ...release,
                _score: score,
                _priority: priority,
                _seedTime: seedTime
            };
        });

        scoredResults.sort((a: any, b: any) => b._score - a._score);
        const bestMatch = scoredResults[0];

        try {
            const downloadLink = bestMatch.magnetUrl || bestMatch.downloadUrl;
            if (!downloadLink) return { success: false, message: "Best match had no download link" };

            const clients = await prisma.downloadClient.findMany();
            if (clients.length === 0) return { success: false, message: "No download client configured." };
            const client = clients[0]; 

            await DownloadService.addDownload(client, downloadLink, bestMatch.title, bestMatch._seedTime || 0, 0);

            const trackingHash = bestMatch.infoHash || bestMatch.guid || downloadLink;

            return { success: true, release: bestMatch.title, indexer: bestMatch.indexer, downloadLink: trackingHash };

        } catch (e: any) {
            return { success: false, message: `Download client error: ${getErrorMessage(e)}` };
        }
    }
};