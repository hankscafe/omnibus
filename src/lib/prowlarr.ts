// src/lib/prowlarr.ts
import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';

export const ProwlarrService = {
  async searchComics(query: string, isInteractive: boolean = false) {
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

    let configuredIndexers: any[] = [];
    try {
        if (config.prowlarr_indexers_config) {
            configuredIndexers = JSON.parse(config.prowlarr_indexers_config);
        }
    } catch (e) {
        Logger.log(`[Prowlarr] Failed to parse indexers config`, 'warn');
    }

    // --- RE-ADD CUSTOM HEADERS FROM SETTINGS ---
    let reqHeaders: any = { 'X-Api-Key': config.prowlarr_key };
    try {
        if (config.custom_headers) {
            const parsedHeaders = JSON.parse(config.custom_headers);
            parsedHeaders.forEach((h: any) => {
                if (h.key && h.value) reqHeaders[h.key] = h.value;
            });
        }
    } catch (e) {}

    const params = new URLSearchParams();
    params.append('query', cleanQuery);
    params.append('type', 'search');
    params.append('apikey', config.prowlarr_key);

    searchCategories.forEach(cat => {
        params.append('categories', cat);
    });

    if (configuredIndexers.length > 0) {
        configuredIndexers.forEach(idx => {
            params.append('indexerIds', idx.id.toString());
        });
    }

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      
      Logger.log(`[Prowlarr] Searching: ${url.replace(config.prowlarr_key, 'REDACTED')}`, 'info');

      const { data } = await axios.get(url, {
          headers: reqHeaders, 
          timeout: 30000 
      });

      // --- NEW DEBUGGING LOGIC ---
      if (!Array.isArray(data)) {
          let preview = "";
          if (typeof data === 'string') {
              // If it's an HTML page (Cloudflare block), grab the first 200 chars
              preview = data.substring(0, 200).replace(/\n/g, ''); 
          } else {
              // If it's a JSON error object from Prowlarr, print it
              preview = JSON.stringify(data).substring(0, 200);
          }
          Logger.log(`[Prowlarr] Unexpected response format. Received payload: ${preview}`, 'error');
          return [];
      }

      return data
        .filter((item: any) => {
            if (isInteractive) return true;
            const title = (item.title || "").toLowerCase();
            return requiredWords.every(w => title.includes(w));
        })
        .map((item: any) => ({
          title: item.title,
          downloadUrl: item.downloadUrl || item.magnetUrl, 
          size: item.size,
          indexer: item.indexer,
          protocol: item.protocol || 'torrent',
          seeders: item.seeders || 0,
          leechers: item.leechers || 0,
          guid: item.guid,
          infoHash: item.infoHash,
          publishDate: item.publishDate
        }));
    } catch (error: any) {
      Logger.log(`[Prowlarr] Search Error: ${error.message}`, 'error');
      return [];
    }
  }
};