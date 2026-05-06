// src/lib/automation.ts
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { Importer } from '@/lib/importer';
import { getErrorMessage } from './utils/error';
import { SystemNotifier } from '@/lib/notifications';

export async function getDownloadClient() {
  const clients = await prisma.downloadClient.findMany();
  return clients.length > 0 ? clients[0] : null;
}

export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const acronyms = await getCustomAcronyms();
  const queries = generateSearchQueries(name, year, acronyms, isManga);
  Logger.log(`[Automation Debug] Generated Fuzzy Queries for req [${requestId}]: ${JSON.stringify(queries)}`, 'debug');

  // 1. Parse Hoster Settings
  const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
  let hasEnabledHosters = true;
  let enabledHosters = ['mediafire', 'getcomics', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox', 'annas_archive'];
  
  if (hpSetting?.value) {
      try {
          const parsed = JSON.parse(hpSetting.value);
          if (parsed.length > 0) {
              if (typeof parsed[0] === 'string') {
                  enabledHosters = parsed;
              } else if (typeof parsed[0] === 'object') {
                  enabledHosters = parsed.filter((p: any) => p.enabled).map((p: any) => p.hoster);
              }
              hasEnabledHosters = enabledHosters.length > 0;
          } else {
              enabledHosters = [];
              hasEnabledHosters = false;
          }
      } catch(e) {}
  }
  
  let getComicsResults: any[] = [];
  
  // Variables to hold a manual link in memory if we need to fall back to Prowlarr
  let fallbackManualUrl: string | null = null;
  let fallbackManualName: string | null = null;

  if (hasEnabledHosters) {
      Logger.log(`[Automation] Priority Phase: Searching GetComics...`, 'info');
      for (const query of queries) {
        Logger.log(`[Automation Debug] Evaluating GetComics search phrase: "${query}"`, 'debug');
          getComicsResults = await GetComicsService.search(query, false, isManga);
          if (getComicsResults.length > 0) break;
      }
      
      if (getComicsResults.length > 0) {
        // --- NEW: Variant / Special Edition Safety Net ---
            // Strip out parentheses, brackets, and symbols to see if the core titles are actually different
            const normalizeTitle = (t: string) => {
                let clean = t.toLowerCase()
                    .replace(/\(.*?\)/g, '') // Remove (2024)
                    .replace(/\[.*?\]/g, '') // Remove [Webrip]
                    .replace(/[^a-z0-9\s]/g, ' ') // Remove punctuation
                    .replace(/\b(issue|vol|volume|book|ch|chapter|part)\b/g, '') // Remove filler words
                    .replace(/\s+/g, '') // Remove all spaces
                    .trim();
                return clean;
            };
            
            const uniqueTitles = new Set(getComicsResults.map(r => normalizeTitle(r.title)));
            
            if (uniqueTitles.size > 1) {
                Logger.log(`[Automation] Multiple distinct editions found on GetComics for ${name}. Stalling for Admin review.`, 'warn');
                
                const currentReq = await prisma.request.findUnique({ 
                    where: { id: requestId },
                    include: { user: true }
                });

                await prisma.request.update({
                    where: { id: requestId },
                    data: { status: 'STALLED' }
                });

                await SystemNotifier.sendAlert('download_failed', {
                    title: name,
                    imageUrl: currentReq?.imageUrl,
                    user: currentReq?.user?.username,
                    description: `Multiple distinct versions (variants/special editions) were found on GetComics for **${name}**. Please use Interactive Search in the Active Downloads queue to select the correct edition.`,
                    publisher: publisher,
                    year: year
                }).catch(() => {});
                
                return;
            }
        const best = getComicsResults[0];
        const { url, hoster } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
        const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
        
        // AIRTIGHT CHECK: Ensure the scraped hoster is actually enabled in the admin settings
        if (enabledHosters.includes(hoster)) {
          const settings = await prisma.systemSetting.findMany();
          const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

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
          Logger.log(`[Automation] [GetComics] Best match was an unsupported/disabled hoster (${hoster}). Holding manual link and falling back to Prowlarr...`, 'warn');
          // Hold the URL in memory to save as MANUAL_DDL only if Phase 2 fails
          fallbackManualUrl = url;
          fallbackManualName = safeTitle;
        }
      } else {
        Logger.log(`[Automation] [GetComics] No valid matches found across all variations.`, 'info');
      }
  } else {
      Logger.log(`[Automation] Priority Phase Skipped: All file hosters are disabled in settings.`, 'info');
  }

  // --- PHASE 2: INDEXER FALLBACK ---
  if (!skipIndexers) {
      Logger.log(`[Automation] Fallback Phase: Searching Prowlarr...`, 'info');
      let healthyResults: any[] = [];

      for (const query of queries) {
          Logger.log(`[Automation] Searching Prowlarr: "${query}"`, 'info');
          Logger.log(`[Automation Debug] Searching Prowlarr: "${query}"`, 'debug');
          const prowlarrResults = await ProwlarrService.searchComics(query, false, isManga);
          Logger.log(`[Automation Debug] Prowlarr Raw Results Count: ${prowlarrResults.length}. Healthy Results (Seeders > 0): ${healthyResults.length}`, 'debug');
          healthyResults = prowlarrResults.filter((r: any) => r.seeders > 0 || r.protocol === 'usenet');
          Logger.log(`[Automation Debug] Prowlarr Raw Results Count: ${prowlarrResults.length}. Healthy Results (Seeders > 0): ${healthyResults.length}`, 'debug');
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
  // If Prowlarr failed, but GetComics found a disabled hoster link, save it to the manual queue now (only if getcomics is allowed!)
  if (fallbackManualUrl && enabledHosters.includes('getcomics')) {
      Logger.log(`[Automation] Prowlarr failed. Reverting to GetComics Manual DDL fallback.`, 'warn');
      await prisma.request.update({
         where: { id: requestId },
         data: { status: 'MANUAL_DDL', downloadLink: fallbackManualUrl, activeDownloadName: fallbackManualName }
      });
      return;
  }

  // If we reach this line, the file was not found ANYWHERE.
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