import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';

export const ProwlarrService = {
  async searchComics(query: string) {
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (!config.prowlarr_url || !config.prowlarr_key) {
      Logger.log('[Prowlarr] Missing configuration.', 'error');
      return [];
    }

    // --- SANITIZATION ---
    // Remove colons, dashes, and duplicate spaces
    const cleanQuery = query.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Determine configured indexers and keep their full configs
    let indexerConfigs: any[] = [];
    let indexerIds: number[] = [];
    
    if (config.prowlarr_indexers_config) {
        try {
            indexerConfigs = JSON.parse(config.prowlarr_indexers_config);
            indexerIds = indexerConfigs.map((i: any) => i.id);
        } catch (e) {}
    }

    const params = new URLSearchParams({
      apikey: config.prowlarr_key,
      t: 'search',
      q: cleanQuery, 
      cat: '7030,7000,8000', 
      extended: '1'
    });

    if (indexerIds.length > 0) {
        indexerIds.forEach((id: number) => params.append('indexer', id.toString()));
    }

    try {
      const url = `${config.prowlarr_url.replace(/\/$/, '')}/api/v1/search?${params.toString()}`;
      
      const { data } = await axios.get(url, { timeout: 30000 });

      if (!Array.isArray(data)) return [];

      return data
        .filter((item: any) => {
            // Filter logic: Must match mostly
            const title = item.title.toLowerCase();
            const q = cleanQuery.toLowerCase().split(' ')[0]; // Match at least the first word
            return title.includes(q);
        })
        .map((item: any) => {
          // Find the specific settings for this indexer
          const idxConfig = indexerConfigs.find((c: any) => c.id === item.indexerId);
          const priority = idxConfig ? idxConfig.priority : 1;
          const seedTime = idxConfig ? idxConfig.seedTime : 0;
          const seedRatio = idxConfig ? (idxConfig.seedRatio || 0) : 0; // Added Seed Ratio
          const seeders = item.seeders || 0;
          
          // Calculate score: Priority dominates, seeders break ties within the same priority
          const score = (priority * 100000) + seeders;

          return {
            title: item.title,
            downloadUrl: item.downloadUrl || item.magnetUrl, 
            size: item.size,
            age: item.age, 
            indexer: item.indexer,
            protocol: item.protocol || 'torrent',
            seeders: seeders,
            guid: item.guid,
            infoHash: item.infoHash,
            priority: priority,
            seedTime: seedTime,
            seedRatio: seedRatio, // Added Seed Ratio
            score: score // Added score for sorting
          };
        });

    } catch (error: any) {
      Logger.log(`[Prowlarr] Search Error: ${error.message}`, 'error');
      return [];
    }
  }
};