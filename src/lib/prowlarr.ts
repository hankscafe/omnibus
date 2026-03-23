// src/lib/prowlarr.ts
import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';
import { getCustomHeaders } from './utils/headers';
import { getErrorMessage } from './utils/error';
import { ProwlarrSearchResult } from '@/types';

export const ProwlarrService = {
  async searchComics(query: string, isInteractive: boolean = false): Promise<ProwlarrSearchResult[]> {
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
          const fallbacks = [...cleanQuery.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
          if (fallbacks.length > 0) reqNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
      }

      return rawData
        .filter((item) => {
            if (isInteractive) return true;
            const titleLower = (String(item.title || "")).toLowerCase();
            
            // STRICT FILTER 1: Reject Omnibuses for Single Issue Searches
            const isLookingForOmnibus = queryWords.includes('omnibus') || queryWords.includes('tpb') || queryWords.includes('compendium') || queryWords.includes('absolute') || queryWords.includes('collection');
            if (reqNum !== null && !isLookingForOmnibus) {
                if (titleLower.includes('omnibus') || titleLower.includes('tpb') || titleLower.includes('compendium') || titleLower.includes('absolute') || titleLower.includes('collection')) {
                    return false;
                }
            }

            // STRICT FILTER 2: Direct Number Comparison
            let cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, '');
            let torNumMatch = cleanTor.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
            let torNum = torNumMatch ? parseFloat(torNumMatch[1]) : null;
            if (torNum === null) {
                const fallbacks = [...cleanTor.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
                if (fallbacks.length > 0) torNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
            }

            if (reqNum !== null) {
                if (torNum !== null && torNum !== reqNum) return false;
                if (torNum === null) {
                    const numRegex = new RegExp(`(?:^|[^a-zA-Z0-9])0*${reqNum}(?:[^a-zA-Z0-9]|$)`, 'i');
                    if (!numRegex.test(titleLower)) return false; 
                }
            }

            // STRICT FILTER 3: Check standard text words
            for (let w of queryWords) {
                if (!/^\d+$/.test(w) && !titleLower.includes(w)) return false;
            }

            return true;
        })
        .map((item): ProwlarrSearchResult => ({
          guid: String(item.guid || ""),
          title: String(item.title || ""),
          size: Number(item.size || 0),
          indexer: String(item.indexer || ""),
          seeders: Number(item.seeders || 0),
          peers: Number(item.leechers || item.peers || 0),
          infoUrl: String(item.infoUrl || ""),
          downloadUrl: String(item.downloadUrl || item.magnetUrl || ""),
          protocol: item.protocol === 'torrent' ? 'torrent' : 'usenet',
          publishDate: item.publishDate ? String(item.publishDate) : undefined
        }));
    } catch (error: unknown) {
      Logger.log(`[Prowlarr] Search Error: ${getErrorMessage(error)}`, 'error');
      return [];
    }
  }
};