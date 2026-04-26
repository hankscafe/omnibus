import axios from 'axios';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { getCustomHeaders } from './utils/headers';
import { getErrorMessage } from './utils/error';

// =========================================================================
// 1. FUZZY SEARCH GENERATOR UTILITIES
// Used by the automation queue to create smart search variations
// =========================================================================

export async function getCustomAcronyms(): Promise<Record<string, string>> {
    const acronyms = await prisma.searchAcronym.findMany();
    const defaults = { 'tmnt': 'teenage mutant ninja turtles', 'asm': 'amazing spider-man', 'f4': 'fantastic four', 'jla': 'justice league of america' };
    if (acronyms.length === 0) return defaults;
    const acMap: Record<string, string> = {};
    acronyms.forEach((a: any) => { if (a.key && a.value) acMap[a.key.toLowerCase()] = a.value.toLowerCase(); });
    return acMap;
}

export function generateSearchQueries(name: string, year: string, acronyms: Record<string, string>, isManga: boolean = false): string[] {
    const queries = new Set<string>();
    const baseName = name.replace(/[#]/g, '').trim();

    // 1. ANCHOR: Full Name + Year (Highest priority for monitoring)
    if (year) queries.add(`${baseName} ${year}`.trim());

    // 2. RESTORED: All fuzzy variations from your original logic
    const noPossessive = baseName.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
    const broadClean = noPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    queries.add(baseName);
    if (year) queries.add(`${broadClean} ${year}`.trim());
    queries.add(broadClean);

    // 3. RESTORED: Dash Special Cleaning
    if (baseName.match(/[\/:\&]/)) {
        const dashed = baseName.replace(/[\/:\&]/g, ' - ').replace(/\s+/g, ' ').trim();
        if (year) queries.add(`${dashed} ${year}`.trim());
        queries.add(dashed);
    }

    // 4. Subtitle extraction and Main Part isolation for complex titles
    // We strictly look for separators that appear AFTER the issue number to avoid truncating series names that naturally contain colons.
    const issueMatch = name.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
    
    let mainPart = name;
    let subtitle = "";
    let hasSubtitle = false;

    if (issueMatch && issueMatch.index !== undefined) {
        const afterIssueIdx = issueMatch.index + issueMatch[0].length;
        const remainder = name.substring(afterIssueIdx);
        
        // Only split if the remainder starts with a colon or spaced hyphen
        const splitMatch = remainder.match(/^\s*(:| - )\s*(.*)$/);
        if (splitMatch) {
            mainPart = name.substring(0, afterIssueIdx).trim();
            subtitle = splitMatch[2].trim();
            hasSubtitle = true;
        }
    } else {
        // For volumes/events without an issue number, we only split if there is a spaced hyphen.
        // Splitting on colons here is too dangerous (e.g. "Avatar: The Last Airbender")
        if (name.includes(' - ')) {
            const parts = name.split(' - ');
            mainPart = parts[0].trim();
            subtitle = parts.slice(1).join(' - ').trim();
            hasSubtitle = true;
        }
    }

    if (hasSubtitle) {
        // 4a. Isolate the Main Part (e.g. "Superman Unlimited 012")
        const mainPartClean = mainPart.replace(/[#]/g, '').trim();
        const mainNoPossessive = mainPartClean.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
        const mainBroadClean = mainNoPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (mainBroadClean.length > 2) {
            if (year) queries.add(`${mainBroadClean} ${year}`.trim());
            queries.add(mainBroadClean);
            
            let mainExpanded = mainBroadClean;
            for (const [ac, full] of Object.entries(acronyms)) {
                const regex = new RegExp(`\\b${ac}\\b`, 'gi');
                mainExpanded = mainExpanded.replace(regex, full);
            }
            if (mainExpanded.toLowerCase() !== mainBroadClean.toLowerCase()) {
                if (year) queries.add(`${mainExpanded} ${year}`.trim());
                queries.add(mainExpanded);
            }
        }

        // 4b. Isolate the Subtitle (e.g. "Besides Myself")
        const subNoPossessive = subtitle.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
        const subBroadClean = subNoPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (subBroadClean.length > 3) {
            if (year) {
                queries.add(`${subBroadClean} ${year}`.trim());
            }
            
            let subExpanded = subBroadClean;
            for (const [ac, full] of Object.entries(acronyms)) {
                const regex = new RegExp(`\\b${ac}\\b`, 'gi');
                subExpanded = subExpanded.replace(regex, full);
            }
            if (subExpanded.toLowerCase() !== subBroadClean.toLowerCase()) {
                if (year) {
                    queries.add(`${subExpanded} ${year}`.trim());
                }
            }
        }
    }

    // 5. Acronym expansion logic
    let expanded = broadClean;
    for (const [ac, full] of Object.entries(acronyms)) {
        const regex = new RegExp(`\\b${ac}\\b`, 'gi');
        expanded = expanded.replace(regex, full);
    }
    if (expanded.toLowerCase() !== broadClean.toLowerCase()) {
        if (year) queries.add(`${expanded} ${year}`.trim());
        queries.add(expanded);
    }

    return Array.from(queries);
}

// =========================================================================
// 2. ADMIN FORCE-SEARCH ENGINE
// =========================================================================

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

            return { success: true, release: bestMatch.title, indexer: bestMatch.indexer };

        } catch (e: any) {
            return { success: false, message: `Download client error: ${getErrorMessage(e)}` };
        }
    }
};