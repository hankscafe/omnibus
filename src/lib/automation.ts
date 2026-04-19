// src/lib/automation.ts
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { Importer } from '@/lib/importer';
import { getErrorMessage } from './utils/error';
// --- CHANGED: Injecting the unified notifier ---
import { SystemNotifier } from '@/lib/notifications';

export async function getDownloadClient() {
  const clients = await prisma.downloadClient.findMany();
  return clients.length > 0 ? clients[0] : null;
}

export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const acronyms = await getCustomAcronyms();
  const queries = generateSearchQueries(name, year, acronyms, isManga);
  
  Logger.log(`[Automation] Priority Phase: Searching GetComics...`, 'info');
  let getComicsResults: any[] = [];
  for (const query of queries) {
      getComicsResults = await GetComicsService.search(query, false, isManga);
      if (getComicsResults.length > 0) break;
  }
  
  if (getComicsResults.length > 0) {
    const best = getComicsResults[0];
    const { url, isDirect, hoster } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
    
    if (isDirect || ['mediafire', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox'].includes(hoster)) {
      const settings = await prisma.systemSetting.findMany();
      const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
      const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();

      await prisma.request.update({
        where: { id: requestId },
        data: { status: 'DOWNLOADING', activeDownloadName: safeTitle }
      });

      DownloadService.downloadDirectFile(url, safeTitle, config.download_path, requestId, hoster)
        .then(async (success) => {
            if (success) {
                await new Promise(r => setTimeout(r, 2000));
                await Importer.importRequest(requestId);
            }
        })
        .catch(e => Logger.log(getErrorMessage(e), 'error'));
      
      return; 
    } else {
      Logger.log(`[Automation] [GetComics] Best match was an unsupported hoster (${hoster}). Saved to Manual Queue.`, 'warn');
      await prisma.request.update({
        where: { id: requestId },
        data: { status: 'MANUAL_DDL', downloadLink: url }
      });
      return; // Exit early since it's queued manually
    }
  } else {
    Logger.log(`[Automation] [GetComics] No valid matches found across all variations.`, 'info');
  }

  // --- PHASE 2: INDEXER FALLBACK ---
  if (!skipIndexers) {
      Logger.log(`[Automation] Fallback Phase: Searching Prowlarr...`, 'info');
      let healthyResults: any[] = [];

      for (const query of queries) {
          Logger.log(`[Automation] Searching Prowlarr: "${query}"`, 'info');
          const prowlarrResults = await ProwlarrService.searchComics(query, false, isManga);
          healthyResults = prowlarrResults.filter((r: any) => r.seeders > 0 || r.protocol === 'usenet');
          if (healthyResults.length > 0) {
              break; 
          }
      }

      if (healthyResults.length > 0) {
        healthyResults.sort((a: any, b: any) => b.score - a.score);
        const best = healthyResults[0];
        
        const config = await getDownloadClient();
        if (config) {
          Logger.log(`[Automation] Sending to Client: ${best.title}`, 'info');
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

  // --- FAILURE PHASE ---
  // If we reach this line, the file was not found on GetComics OR Prowlarr.
  const currentReq = await prisma.request.findUnique({ 
      where: { id: requestId },
      include: { user: true }
  });

  if (currentReq?.status !== 'MANUAL_DDL' && currentReq?.status !== 'DOWNLOADING') {
      Logger.log(`[Automation] No results found anywhere for: ${name}`, 'warn');
      
      await prisma.request.update({
         where: { id: requestId },
         data: { status: 'STALLED' }
      });

      // --- CHANGED: Send a system alert so the user knows their request failed ---
      await SystemNotifier.sendAlert('download_failed', {
          title: name,
          imageUrl: currentReq?.imageUrl,
          user: currentReq?.user?.username,
          description: `Omnibus searched all connected indexers and direct download sites but could not find a match for **${name}**.`,
          publisher: publisher,
          year: year
      }).catch(() => {});
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