import axios from 'axios';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { getCustomHeaders } from './utils/headers';

// =========================================================================
// 1. FUZZY SEARCH GENERATOR UTILITIES
// Used by the automation queue to create smart search variations
// =========================================================================

export async function getCustomAcronyms(): Promise<Record<string, string>> {
    // NATIVE DB FETCH: Read from the search acronym table
    const acronyms = await prisma.searchAcronym.findMany();
    const defaults = { 'tmnt': 'teenage mutant ninja turtles', 'asm': 'amazing spider-man', 'f4': 'fantastic four', 'jla': 'justice league of america', 'jl': 'justice league', 'gotg': 'guardians of the galaxy', 'avx': 'avengers vs x-men', 'x-men': 'x men' };
    
    if (acronyms.length === 0) return defaults;
    
    const acMap: Record<string, string> = {};
    acronyms.forEach((a: any) => { 
        if (a.key && a.value) acMap[a.key.toLowerCase()] = a.value.toLowerCase(); 
    });
    
    return Object.keys(acMap).length > 0 ? acMap : defaults;
}

export function generateSearchQueries(name: string, year: string, acronyms: Record<string, string>, isManga: boolean = false): string[] {
    const queries = new Set<string>();

    // 1. Base Name: Strip issue hash, but LEAVE apostrophes for exact match attempts on Prowlarr
    const baseName = name.replace(/[#]/g, '').trim();

    // --- NEW: MANGA SPECIFIC VARIATIONS ---
    // If it's manga, and the name has a number at the end, generate explicit Vol/Ch variations
    if (isManga) {
        const numMatch = name.match(/#?(\d+(?:\.\d+)?)$/);
        if (numMatch) {
            const pureName = name.replace(/#?(\d+(?:\.\d+)?)$/, '').trim();
            const volVariation = `${pureName} Vol ${numMatch[1]}`.trim();
            const vVariation = `${pureName} v${numMatch[1]}`.trim();
            const chVariation = `${pureName} Ch ${numMatch[1]}`.trim();
            
            if (year) {
                queries.add(`${volVariation} ${year}`);
                queries.add(`${vVariation} ${year}`);
            }
            queries.add(volVariation);
            queries.add(vVariation);
            queries.add(chVariation);
        }
    }

    if (year) queries.add(`${baseName} ${year}`.trim());
    queries.add(baseName);

    // 2. THE POSSESSIVE STRIPPER (Crucial for WordPress / GetComics)
    const noPossessive = baseName.replace(/'s\b/gi, '').replace(/’s\b/gi, '');

    // 3. BROAD ALPHANUMERIC CLEAN
    const broadClean = noPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    if (year) queries.add(`${broadClean} ${year}`.trim());
    queries.add(broadClean);

    // 4. THE GETCOMICS DASH SPECIAL
    if (baseName.match(/[\/:\&]/)) {
        const dashed = baseName.replace(/[\/:\&]/g, ' - ').replace(/\s+/g, ' ').trim();
        if (year) queries.add(`${dashed} ${year}`.trim());
        queries.add(dashed);

        const dashedNoPossessive = noPossessive.replace(/[\/:\&]/g, ' - ').replace(/\s+/g, ' ').trim();
        if (year) queries.add(`${dashedNoPossessive} ${year}`.trim());
        queries.add(dashedNoPossessive);
    }

    // 5. Common Acronyms
    let expanded = broadClean;
    for (const [ac, full] of Object.entries(acronyms)) {
        const regex = new RegExp(`\\b${ac}\\b`, 'gi');
        if (regex.test(expanded)) {
            expanded = expanded.replace(regex, full);
        }
    }
    
    if (expanded.toLowerCase() !== broadClean.toLowerCase()) {
        if (year) queries.add(`${expanded} ${year}`.trim());
        queries.add(expanded);
    }

    // 6. Subtitle extraction
    if (name.includes(':')) {
        const parts = name.split(':');
        const subtitle = parts.slice(1).join(' ').replace(/[#]/g, '').trim();
        const subNoPossessive = subtitle.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
        const subBroadClean = subNoPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (subBroadClean.length > 3) {
            // ONLY add the subtitle query if we have a specific year to pair it with
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
            return { success: false, message: `Download client error: ${e.message}` };
        }
    }
};