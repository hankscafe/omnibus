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

    // Extract configurable Torznab categories, default to Comics (7030) and Manga (8030)
    const categoriesStr = config.prowlarr_categories || '7030,8030';
    const cleanCats = categoriesStr.split(',').map((c: string) => c.trim()).filter(Boolean).join(',');

    const params = new URLSearchParams({ 
        apikey: config.prowlarr_key, 
        t: 'search', 
        q: cleanQuery, 
        cat: cleanCats, 
        extended: '1' 
    });

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      const { data } = await axios.get(url, { timeout: 30000 });
      if (!Array.isArray(data)) return [];

      return data
        .filter((item: any) => {
            // INTERACTIVE BYPASS: If the user is manually searching, show ALL results.
            if (isInteractive) return true;
            const title = item.title.toLowerCase();
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