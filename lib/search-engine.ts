import axios from 'axios';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { getCustomHeaders } from './utils/headers';

// =========================================================================
// 1. FUZZY SEARCH GENERATOR UTILITIES
// Used by the automation queue to create smart search variations
// =========================================================================

export async function getCustomAcronyms(): Promise<Record<string, string>> {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'search_acronyms' } });
    const defaults = { 'tmnt': 'teenage mutant ninja turtles', 'asm': 'amazing spider-man', 'f4': 'fantastic four', 'jla': 'justice league of america', 'jl': 'justice league', 'gotg': 'guardians of the galaxy', 'avx': 'avengers vs x-men', 'x-men': 'x men' };
    
    if (!setting?.value) return defaults;
    
    try {
        const parsed = JSON.parse(setting.value);
        const acMap: Record<string, string> = {};
        parsed.forEach((item: any) => { 
            if (item.key && item.value) acMap[item.key.toLowerCase()] = item.value.toLowerCase(); 
        });
        return Object.keys(acMap).length > 0 ? acMap : defaults;
    } catch (e) {
        return defaults;
    }
}

export function generateSearchQueries(name: string, year: string, acronyms: Record<string, string>): string[] {
    const queries = new Set<string>();

    // 1. Base Name: Strip issue hash, but LEAVE apostrophes for exact match attempts on Prowlarr
    const baseName = name.replace(/[#]/g, '').trim();

    if (year) queries.add(`${baseName} ${year}`.trim());
    queries.add(baseName);

    // 2. THE POSSESSIVE STRIPPER (Crucial for WordPress / GetComics)
    // Converts "Devil's" -> "Devil" (Because "Devils" will fail against "Devil’s" in WP Search)
    const noPossessive = baseName.replace(/'s\b/gi, '').replace(/’s\b/gi, '');

    // 3. BROAD ALPHANUMERIC CLEAN
    // Converts "Daredevil/Punisher: The Devil Trigger" -> "Daredevil Punisher The Devil Trigger"
    const broadClean = noPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    if (year) queries.add(`${broadClean} ${year}`.trim());
    queries.add(broadClean);

    // 4. THE GETCOMICS DASH SPECIAL
    // Converts "Daredevil/Punisher" -> "Daredevil - Punisher"
    if (baseName.match(/[\/:\&]/)) {
        const dashed = baseName.replace(/[\/:\&]/g, ' - ').replace(/\s+/g, ' ').trim();
        if (year) queries.add(`${dashed} ${year}`.trim());
        queries.add(dashed);

        const dashedNoPossessive = noPossessive.replace(/[\/:\&]/g, ' - ').replace(/\s+/g, ' ').trim();
        if (year) queries.add(`${dashedNoPossessive} ${year}`.trim());
        queries.add(dashedNoPossessive);
    }

    // 5. Common Acronyms (e.g. TMNT -> Teenage Mutant Ninja Turtles)
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

    // 6. Subtitle extraction (e.g. "TMNT: The Last Ronin" -> "The Last Ronin")
    if (name.includes(':')) {
        const parts = name.split(':');
        const subtitle = parts.slice(1).join(' ').replace(/[#]/g, '').trim();
        const subNoPossessive = subtitle.replace(/'s\b/gi, '').replace(/’s\b/gi, '');
        const subBroadClean = subNoPossessive.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (subBroadClean.length > 3) {
            if (year) queries.add(`${subBroadClean} ${year}`.trim());
            queries.add(subBroadClean);
            
            let subExpanded = subBroadClean;
            for (const [ac, full] of Object.entries(acronyms)) {
                const regex = new RegExp(`\\b${ac}\\b`, 'gi');
                subExpanded = subExpanded.replace(regex, full);
            }
            if (subExpanded.toLowerCase() !== subBroadClean.toLowerCase()) {
                if (year) queries.add(`${subExpanded} ${year}`.trim());
                queries.add(subExpanded);
            }
        }
    }

    return Array.from(queries);
}

// =========================================================================
// 2. ADMIN FORCE-SEARCH ENGINE
// Used exclusively by the Admin "Force Search" button for manual overrides
// =========================================================================

interface IndexerConfig {
    id: number;
    name: string;
    priority: number;
    seedTime: number;
    rss: boolean;
}

export const SearchEngine = {

    async performSmartSearch(query: string) {
        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        if (!config.prowlarr_url || !config.prowlarr_key) {
            throw new Error("Prowlarr not configured");
        }

        let indexerConfigs: IndexerConfig[] = [];
        try {
            if (config.prowlarr_indexers_config) {
                indexerConfigs = JSON.parse(config.prowlarr_indexers_config);
            }
        } catch (e) {
            console.error("Failed to parse indexer config", e);
        }

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
            
            if (!downloadLink) {
                 return { success: false, message: "Best match had no download link" };
            }

            const hash = await DownloadService.addTorrent(downloadLink, 'comics');

            if (hash) {
                if (bestMatch._seedTime > 0) {
                    await DownloadService.setSeedingLimit(hash, bestMatch._seedTime);
                }
                return { success: true, release: bestMatch.title, indexer: bestMatch.indexer };
            } else {
                return { success: false, message: "Failed to add to qBittorrent" };
            }

        } catch (e: any) {
            return { success: false, message: `Download client error: ${e.message}` };
        }
    }
};