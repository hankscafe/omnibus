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
    const requiredWords = queryWords.slice(0, Math.min(2, queryWords.length)); 

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
    
    // Explicit Record type for headers
    const reqHeaders: Record<string, string> = { 
        'X-Api-Key': config.prowlarr_key,
        ...customHeaders
    };

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      Logger.log(`[Prowlarr] Searching: ${url}`, 'info');

      // Strictly typing the expected generic response array
      const { data } = await axios.get<unknown[] | string | Record<string, unknown>>(url, {
          headers: reqHeaders, 
          timeout: 30000 
      });

      if (!Array.isArray(data)) {
          let preview = "";
          if (typeof data === 'string') {
              preview = data.substring(0, 200).replace(/\n/g, ''); 
          } else {
              preview = JSON.stringify(data).substring(0, 200);
          }
          Logger.log(`[Prowlarr] Unexpected response format. Received payload: ${preview}`, 'error');
          return [];
      }

      // Assert array is an array of objects to map through
      const rawData = data as Record<string, unknown>[];

      return rawData
        .filter((item) => {
            if (isInteractive) return true;
            const title = (String(item.title || "")).toLowerCase();
            return requiredWords.every(w => title.includes(w));
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