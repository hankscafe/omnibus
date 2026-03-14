// src/lib/prowlarr.ts
import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';
import { getCustomHeaders } from './utils/headers';

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

    // NATIVE DB FETCH: Pull configured indexers directly from the database table
    let configuredIndexers: any[] = [];
    try {
        configuredIndexers = await prisma.indexer.findMany();
    } catch (e) {
        Logger.log(`[Prowlarr] Failed to fetch indexers from database`, 'warn');
    }

    const params = new URLSearchParams();
    params.append('query', cleanQuery);
    params.append('type', 'search');
    
    // THE FIX: apikey URL parameter removed here!

    searchCategories.forEach(cat => {
        params.append('categories', cat);
    });

    if (configuredIndexers.length > 0) {
        configuredIndexers.forEach(idx => {
            params.append('indexerIds', idx.id.toString());
        });
    }

    // NATIVE DB FETCH: Grab your Cloudflare Access headers!
    const customHeaders = await getCustomHeaders();
    
    // SECURE AUTH: The API key is passed securely in the hidden HTTP headers
    const reqHeaders: any = { 
        'X-Api-Key': config.prowlarr_key,
        ...customHeaders
    };

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      
      // Update logger so it no longer needs the REDACTED string replacement since the URL is clean
      Logger.log(`[Prowlarr] Searching: ${url}`, 'info');

      const { data } = await axios.get(url, {
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