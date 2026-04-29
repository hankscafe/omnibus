import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';
import { getCustomHeaders } from './utils/headers';
import { getErrorMessage } from './utils/error';
import { ProwlarrSearchResult } from '@/types';

export const ProwlarrService = {
  async searchComics(query: string, isInteractive: boolean = false, isManga: boolean = false): Promise<ProwlarrSearchResult[]> {
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (!config.prowlarr_url || !config.prowlarr_key) return [];

    const cleanQuery = query.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim();
    const stopWords = ['the', 'a', 'an', 'of', 'and', 'or', 'vol', 'volume', 'issue', 'black', 'white', 'blood'];
    const queryWords = cleanQuery.toLowerCase().split(' ').filter(w => w.length > 0);

    const boundedVariantKeywords = ['noir', 'b&w', 'sketch', 'blank', 'virgin', 'uncut'];
    const openVariantKeywords = ['variant', 'special edition', "director's cut", "directors cut", 'facsimile', 'black and white', 'extended'];
    const userWantsVariant = [...boundedVariantKeywords, ...openVariantKeywords].some(k => cleanQuery.toLowerCase().includes(k));

    let configuredIndexers: { id: number | string }[] = [];
    try {
        configuredIndexers = await prisma.indexer.findMany();
    } catch (e: unknown) {
        Logger.log(`[Prowlarr] Failed to fetch indexers: ${getErrorMessage(e)}`, 'warn');
    }

    const params = new URLSearchParams();
    params.append('query', cleanQuery);
    params.append('type', 'search');
    
    const categoriesStr = config.prowlarr_categories || '7030, 8030';
    categoriesStr.split(',').map(c => c.trim()).filter(Boolean).forEach(cat => params.append('categories', cat));

    if (configuredIndexers.length > 0) {
        configuredIndexers.forEach(idx => params.append('indexerIds', idx.id.toString()));
    }

    const customHeaders = await getCustomHeaders();
    const reqHeaders: Record<string, string> = { 'X-Api-Key': config.prowlarr_key, ...customHeaders };

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      const { data } = await axios.get<any[]>(url, { headers: reqHeaders, timeout: 30000 });

      if (!Array.isArray(data)) return [];

      let reqNumMatch = cleanQuery.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
      let reqNum = reqNumMatch ? parseFloat(reqNumMatch[1]) : null;
      
      const reqYearMatch = cleanQuery.match(/\b(19|20)\d{2}\b/);
      const reqYear = reqYearMatch ? reqYearMatch[1] : null;

      const significantQueryWords = queryWords.filter(w => !stopWords.includes(w.toLowerCase()) && w.length > 2 && w !== reqYear);

      return data
        .filter((item) => {
            if (isInteractive) return true;
            const titleLower = (String(item.title || "")).toLowerCase();
            
            // 1. PERSISTENT YEAR ANCHOR
            const originalReqYear = query.match(/\b(19|20)\d{2}\b/)?.[0] || reqYear;
            const torYearMatch = titleLower.match(/[\(\[]?(19|20)\d{2}[\)\]]?/);
            const torYear = torYearMatch ? torYearMatch[0].replace(/[\[\]\(\)]/g, '') : null;

            if (originalReqYear) {
                if (torYear && originalReqYear !== torYear) return false; 
                if (!torYear && !titleLower.includes(originalReqYear)) return false; 
            }

            // 2. MANDATORY WORD INTERSECTION
            for (const word of significantQueryWords) {
                if (!titleLower.includes(word.toLowerCase())) return false;
            }

            // 3. REVERSE VALIDATION (Extra Word Check)
            const resultWords = titleLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
                .filter(w => !stopWords.includes(w) && w.length > 2 && w !== torYear);
            const extraWords = resultWords.filter(w => !significantQueryWords.includes(w));
            if (extraWords.length > 1) return false;

            // 4. TPB/Omnibus Filter
            const tpbTerms = ['omnibus', 'tpb', 'compendium', 'absolute', 'collection', 'hc', 'hardcover', 'annual'];
            const isLookingForOmnibus = significantQueryWords.some(w => tpbTerms.includes(w));
            if (reqNum !== null && !isLookingForOmnibus && tpbTerms.some(term => titleLower.includes(term))) {
                return false;
            }

            // --- NEW: Apply Variant Filter ---
            if (!userWantsVariant) {
                if (openVariantKeywords.some(k => titleLower.includes(k))) return false;
                for (const bk of boundedVariantKeywords) {
                    const regex = new RegExp(`\\b${bk}\\b`, 'i');
                    if (regex.test(titleLower)) return false;
                }
            }

            // 5. Issue Number Check
            let cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})\)/g, '');
            let torNumMatch = cleanTor.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
            let torNum = torNumMatch ? parseFloat(torNumMatch[1]) : null;
            
            if (torNum === null) {
                const fallbacks = [...cleanTor.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
                // FIX: Corrected variable name from fallbackMatches to fallbacks
                if (fallbacks.length > 0) torNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
            }

            // REJECTION LOGIC: If we asked for #18 and the result is #17, reject it.
            if (reqNum !== null) {
                if (torNum !== null && torNum !== reqNum) return false;
                if (torNum === null) return false; 
            }

            return true;
        })
        .map((item): ProwlarrSearchResult => {
          let parsedHash = item.infoHash ? String(item.infoHash) : undefined;
          if (!parsedHash && item.magnetUrl) {
              const match = String(item.magnetUrl).match(/urn:btih:([a-zA-Z0-9]+)/i);
              if (match) parsedHash = match[1].toLowerCase();
          }
          return {
            guid: String(item.guid || ""),
            title: String(item.title || ""),
            size: Number(item.size || 0),
            indexer: String(item.indexer || ""),
            seeders: Number(item.seeders || 0),
            peers: Number(item.leechers || item.peers || 0),
            infoUrl: String(item.infoUrl || ""),
            downloadUrl: String(item.downloadUrl || item.magnetUrl || ""),
            protocol: item.protocol === 'torrent' ? 'torrent' : 'usenet',
            publishDate: item.publishDate ? String(item.publishDate) : undefined,
            infoHash: parsedHash
          };
        });
    } catch (error: unknown) {
      Logger.log(`[Prowlarr] Search Error: ${getErrorMessage(error)}`, 'error');
      return [];
    }
  }
};