import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';
import { getCustomHeaders } from './utils/headers';
import { getErrorMessage } from './utils/error';
import { ProwlarrSearchResult } from '@/types';

export const ProwlarrService = {
  // --- ADDED: isManga parameter to differentiate strict filtering rules ---
  async searchComics(query: string, isInteractive: boolean = false, isManga: boolean = false): Promise<ProwlarrSearchResult[]> {
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (!config.prowlarr_url || !config.prowlarr_key) return [];

    const cleanQuery = query.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim();
    const stopWords = ['the', 'a', 'an', 'of', 'and', 'or', 'vol', 'volume', 'issue'];
    const queryWords = cleanQuery.toLowerCase().split(' ').filter(w => !stopWords.includes(w) && w.length > 0);

    const categoriesStr = config.prowlarr_categories;
    let searchCategories: string[] = [];
    
    if (categoriesStr === undefined) {
        searchCategories = ['7030', '8030'];
    } else if (categoriesStr.trim() !== "") {
        searchCategories = categoriesStr.split(',').map((c: string) => c.trim()).filter(Boolean);
    }

    let configuredIndexers: { id: number | string }[] = [];
    try {
        configuredIndexers = await prisma.indexer.findMany();
    } catch (e: unknown) {
        Logger.log(`[Prowlarr] Failed to fetch indexers from database: ${getErrorMessage(e)}`, 'warn');
    }

    const params = new URLSearchParams();
    params.append('query', cleanQuery);
    params.append('type', 'search');
    
    searchCategories.forEach(cat => {
        params.append('categories', cat);
    });

    if (configuredIndexers.length > 0) {
        configuredIndexers.forEach(idx => {
            params.append('indexerIds', idx.id.toString());
        });
    }

    const customHeaders = await getCustomHeaders();
    const reqHeaders: Record<string, string> = { 
        'X-Api-Key': config.prowlarr_key,
        ...customHeaders
    };

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      Logger.log(`[Prowlarr] Searching: ${url}`, 'info');

      const { data } = await axios.get<unknown[] | string | Record<string, unknown>>(url, {
          headers: reqHeaders, 
          timeout: 30000 
      });

      if (!Array.isArray(data)) return [];

      const rawData = data as Record<string, unknown>[];

      // Extract expected number from the query to prevent hijacking
      let reqNumMatch = cleanQuery.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
      let reqNum = reqNumMatch ? parseFloat(reqNumMatch[1]) : null;
      if (reqNum === null) {
          let noYearQuery = cleanQuery.replace(/\b(19|20)\d{2}\b/g, '');
          const fallbacks = [...noYearQuery.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
          if (fallbacks.length > 0) reqNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
      }

      // EXTRACT YEAR FROM ORIGINAL QUERY
      const reqYearMatch = cleanQuery.match(/\b(19|20)\d{2}\b/);
      const reqYear = reqYearMatch ? reqYearMatch[1] : null;

      return rawData
        .filter((item) => {
            if (isInteractive) return true;
            const titleLower = (String(item.title || "")).toLowerCase();
            
            // STRICT FILTER 1: Reject Omnibuses for Single Issue Searches
            const tpbTerms = ['omnibus', 'tpb', 'compendium', 'absolute', 'collection', 'hc', 'hardcover', 'trade paperback', 'annual'];
            if (!isManga) {
                // If it is NOT a manga, explicitly add "vol", "volume", and "book" as banned words IF they weren't in the original query
                tpbTerms.push('vol ', 'volume ', 'book ');
            }

            const isLookingForOmnibus = queryWords.some(w => tpbTerms.includes(w));
            if (reqNum !== null && !isLookingForOmnibus) {
                if (tpbTerms.some(term => titleLower.includes(term))) {
                    return false;
                }
            }

            // STRICT FILTER 2: Direct Number Comparison
            let cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, '');
            
            // If it's a Western Comic, aggressively strip out "Vol. X" and "Book X" strings before checking the numbers.
            // This prevents "Moon Knight Vol. 2" from pretending to be "Moon Knight #2"
            let strippedForNumbers = cleanTor;
            if (!isManga) {
                strippedForNumbers = strippedForNumbers.replace(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
                strippedForNumbers = strippedForNumbers.replace(/(?:book\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
            }

            let torNumMatch = strippedForNumbers.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
            let torNum = torNumMatch ? parseFloat(torNumMatch[1]) : null;
            
            if (torNum === null) {
                const fallbacks = [...strippedForNumbers.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
                if (fallbacks.length > 0) torNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
            }

            if (reqNum !== null) {
                if (torNum !== null && torNum !== reqNum) return false;
                if (torNum === null) {
                    return false; // Safely reject it if stripping Vol. left it with NO numbers
                }
            }

            // STRICT FILTER 2.5: Year Conflict Check
            const torYearMatch = titleLower.match(/[\(\[]?(19|20)\d{2}[\)\]]?/);
            const torYear = torYearMatch ? torYearMatch[1] : null;

            if (reqYear && torYear && reqYear !== torYear) {
                return false;
            }

            // STRICT FILTER 3: Check standard text words
            for (let w of queryWords) {
                if (!/^\d+$/.test(w) && !titleLower.includes(w)) return false;
            }

            return true;
        })
        .map((item): ProwlarrSearchResult => {
          // Extract the exact infoHash from the magnet URL if Prowlarr hid it
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