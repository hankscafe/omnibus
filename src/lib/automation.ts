import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { Importer } from '@/lib/importer';
import { getErrorMessage } from './utils/error';

export async function getDownloadClient() {
  const clients = await prisma.downloadClient.findMany();
  return clients.length > 0 ? clients[0] : null;
}

export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const acronyms = await getCustomAcronyms();
  const queries = generateSearchQueries(name, year, acronyms, isManga); // <-- Passed isManga
  
  Logger.log(`[Automation] Generated ${queries.length} search variations for: ${name}`, 'info');
  
  let healthyResults: any[] = [];
  let successfulQuery = "";

  if (!skipIndexers) {
      for (const query of queries) {
          Logger.log(`[Automation] Searching Prowlarr: "${query}"`, 'info');
          const prowlarrResults = await ProwlarrService.searchComics(query, false, isManga); // <-- Passed isManga
          healthyResults = prowlarrResults.filter((r: any) => r.seeders > 0 || r.protocol === 'usenet');
          if (healthyResults.length > 0) {
              successfulQuery = query;
              break; 
          }
      }

      if (healthyResults.length > 0) {
        healthyResults.sort((a: any, b: any) => b.score - a.score);
        const best = healthyResults[0];
        
        const config = await getDownloadClient();
        if (config) {
          Logger.log(`[Automation] Sending to Client: ${best.title} (Priority: ${best.priority})`, 'info');
          await DownloadService.addDownload(config, best.downloadUrl, best.title, best.seedTime || 0, best.seedRatio || 0);
          
          const trackingHash = best.infoHash || best.guid || null;
          
          await prisma.request.update({
            where: { id: requestId },
            data: { status: 'DOWNLOADING', activeDownloadName: best.title, downloadLink: trackingHash }
          });
          return; 
        }
      }
  }

  Logger.log(skipIndexers ? `[Automation] Direct GetComics requested for: ${name}` : `[Automation] Not found on Indexers. Falling back to GetComics...`, 'info');
  
  let getComicsResults: any[] = [];
  for (const query of queries) {
      Logger.log(`[Automation] Searching GetComics: "${query}"`, 'info');
      getComicsResults = await GetComicsService.search(query, false, isManga); // <-- Passed isManga
      if (getComicsResults.length > 0) {
          successfulQuery = query;
          break;
      }
  }
  
  if (getComicsResults.length > 0) {
    const best = getComicsResults[0];
    const { url, isDirect } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
    
    if (isDirect) {
      const settings = await prisma.systemSetting.findMany();
      const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
      const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

      await prisma.request.update({
        where: { id: requestId },
        data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
      });

      DownloadService.downloadDirectFile(url, safeTitle, config.download_path, requestId)
        .then(async (success) => {
            if (success) {
                await new Promise(r => setTimeout(r, 2000));
                await Importer.importRequest(requestId);
            }
        })
        .catch(e => Logger.log(getErrorMessage(e), 'error'));
    } else {
      await prisma.request.update({
        where: { id: requestId },
        data: { status: 'MANUAL_DDL', downloadLink: url }
      });
    }
  } else {
     Logger.log(`[Automation] No results found anywhere for: ${name}`, 'warn');
     await prisma.request.update({
        where: { id: requestId },
        data: { status: 'STALLED' }
     });
  }
}

export async function processAutomationQueue(items: any[]) {
  for (const item of items) {
    try {
      await searchAndDownload(item.id, item.name, item.year, item.publisher, item.isManga, item.skipIndexers);
      await new Promise(r => setTimeout(r, 5000)); 
    } catch (e) {
      Logger.log(`Automation failed for ${item.name}`, 'error');
    }
  }
}