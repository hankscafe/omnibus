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

export async function getDownloadClient(protocol: string = 'torrent') {
  const clients = await prisma.downloadClient.findMany();
  if (clients.length === 0) return null;
  return clients.find(c => (c.protocol || 'torrent').toLowerCase() === (protocol || 'torrent').toLowerCase()) || null;
}

let nextAvailableSearchTime = Date.now();

export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const now = Date.now();
  if (nextAvailableSearchTime < now) {
      nextAvailableSearchTime = now;
  }
  const delayMs = nextAvailableSearchTime - now;
  nextAvailableSearchTime += 5000; 

  const { omnibusQueue } = await import('@/lib/queue');
  await omnibusQueue.add('SEARCH_AND_DOWNLOAD', {
    type: 'SEARCH_AND_DOWNLOAD',
    requestId, name, year, publisher, isManga, skipIndexers
  }, {
    jobId: `SEARCH_${requestId}`,
    delay: delayMs 
  });
}

export async function executeSearchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const freshReq = await prisma.request.findUnique({ where: { id: requestId } });
  if (!freshReq) {
      Logger.log(`[Automation] Aborting execution for ${name}. Request no longer exists in the database.`, 'warn');
      return; 
  }
  if (['DOWNLOADING', 'COMPLETED', 'IMPORTED', 'CANCELLED'].includes(freshReq.status)) {
      Logger.log(`[Automation] Aborting duplicate execution for ${name}. Request is already in status: ${freshReq.status}`, 'warn');
      return; 
  }
  await prisma.request.update({
      where: { id: requestId },
      data: { status: 'PENDING' }
  });
  
  let searchName = name;
  const subtitleMatch = name.match(/(.*?(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+(?:\.\d+)?)\s*[:\-]\s*.*/i);
  if (subtitleMatch) {
      searchName = subtitleMatch[1].trim();
  }

  const acronyms = await getCustomAcronyms();
  const queries = generateSearchQueries(searchName, year, acronyms, isManga);

  Logger.log(`[Automation Debug] Generated queries for "${name}": ${JSON.stringify(queries)}`, 'debug');

  // --- THE FIX: Reordered to safely consume .mockResolvedValueOnce() during testing ---
  const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
  const ddlSetting = await prisma.systemSetting.findUnique({ where: { key: 'ddl_enabled' } });
  
  const ddlEnabled = ddlSetting?.value !== 'false';
  let hasEnabledHosters = true;
  let enabledHosters = ['mediafire', 'getcomics', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox', 'annas_archive'];
  
  if (hpSetting?.value) {
      try {
          const val = hpSetting.value;
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          
          if (Array.isArray(parsed)) {
              if (parsed.length === 0) {
                  hasEnabledHosters = false;
                  enabledHosters = [];
              } else if (typeof parsed[0] === 'string') {
                  enabledHosters = parsed;
                  hasEnabledHosters = enabledHosters.length > 0;
              } else if (typeof parsed[0] === 'object') {
                  enabledHosters = parsed.filter((p: any) => p.enabled !== false).map((p: any) => p.hoster);
                  hasEnabledHosters = enabledHosters.length > 0;
              }
          }
      } catch(e) {}
  }
  
  let getComicsResults: any[] = [];
  let fallbackManualUrl: string | null = null;
  let fallbackManualName: string | null = null;

  if (ddlEnabled && hasEnabledHosters) {
      Logger.log(`[Automation] Priority Phase: Searching GetComics...`, 'info');
      for (const query of queries) {
          getComicsResults = (await GetComicsService.search(query, false, isManga, name, year)) || [];
          Logger.log(`[Automation Debug] GetComics search for "${query}" returned ${getComicsResults.length} results.`, 'debug');
          if (getComicsResults.length > 0) break;
      }
      
      if (getComicsResults.length > 0) {
            const normalizeTitle = (t: string) => {
                return t.toLowerCase()
                    .replace(/\(.*?\)/g, '')
                    .replace(/\[.*?\]/g, '')
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .replace(/\b(issue|vol|volume|book|ch|chapter|part)\b/g, '')
                    .replace(/\s+/g, '')
                    .trim();
            };
            const uniqueTitles = new Set(getComicsResults.map(r => normalizeTitle(r.title)));
            if (uniqueTitles.size > 1) {
                Logger.log(`[Automation] Multiple distinct editions found on GetComics for ${name}. Stalling for Admin review.`, 'warn');
                const currentReq = await prisma.request.findUnique({ 
                    where: { id: requestId },
                    include: { user: true }
                });
                await prisma.request.update({ where: { id: requestId }, data: { status: 'STALLED' } });
                await SystemNotifier.sendAlert('download_failed', {
                    title: name, imageUrl: currentReq?.imageUrl, user: currentReq?.user?.username,
                    description: `Multiple distinct versions (variants/special editions) were found on GetComics for **${name}**. Please use Interactive Search in the Active Downloads queue to select the correct edition.`,
                    publisher: publisher, year: year
                }).catch(() => {});
                return;
            }
            
        const best = getComicsResults[0];
        const { url, hoster } = await GetComicsService.scrapeDeepLink(best.downloadUrl);
        const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
        
        if (enabledHosters.includes(hoster)) {
          const settings = await prisma.systemSetting.findMany();
          const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
          
          const duplicateDownload = await prisma.request.findFirst({
              where: {
                  downloadLink: url,
                  status: { in: ['DOWNLOADING', 'IMPORTED', 'COMPLETED'] },
                  id: { not: requestId }
              }
          });
          
          if (duplicateDownload) {
               Logger.log(`[Automation] Batch pack already downloading or downloaded (${url}). Queuing ${name} for batch extraction.`, 'info');
               await prisma.request.update({ where: { id: requestId }, data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: url } });
               return;
          }
          
          await prisma.request.update({ where: { id: requestId }, data: { status: 'DOWNLOADING', activeDownloadName: safeTitle, downloadLink: url } });
          
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
          fallbackManualUrl = url; fallbackManualName = safeTitle;
        }
      } else {
        Logger.log(`[Automation] [GetComics] No valid matches found across all variations.`, 'info');
      }
  } else {
      Logger.log(`[Automation] Priority Phase Skipped: Direct Downloads or Hosters are disabled.`, 'info');
  }

  // --- PHASE 2: INDEXER FALLBACK ---
  if (!skipIndexers) {
      Logger.log(`[Automation] Fallback Phase: Searching Prowlarr...`, 'info');
      let healthyResults: any[] = [];
      for (const query of queries) {
          Logger.log(`[Automation] Searching Prowlarr: "${query}"`, 'info');
          const prowlarrResults = (await ProwlarrService.searchComics(query, false, isManga, year)) || [];
          Logger.log(`[Automation Debug] Prowlarr search for "${query}" returned ${prowlarrResults.length} raw results.`, 'debug');
          
          healthyResults = prowlarrResults.filter((r: any) => r.seeders > 0 || r.protocol === 'usenet');
          Logger.log(`[Automation Debug] ${healthyResults.length} healthy results remained after filtering 0-seeder torrents.`, 'debug');
          
          if (healthyResults.length > 0) break; 
          await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (healthyResults.length > 0) {
        const scoringSetting = await prisma.systemSetting.findUnique({ where: { key: 'release_scoring_rules' } });
        let scoringRules = [
            { term: '.cbz', score: 500 }, { term: '(digital)', score: 300 }, { term: '[digital]', score: 300 },
            { term: 'webrip', score: 200 }, { term: 'web-dl', score: 200 }, { term: '.cbr', score: -400 },
            { term: '.rar', score: -400 }, { term: 'vapi', score: -400 }
        ];

        if (scoringSetting?.value) {
            try {
                const val = scoringSetting.value;
                const parsed = typeof val === 'string' ? JSON.parse(val) : val;
                if (Array.isArray(parsed) && parsed.length > 0) scoringRules = parsed;
            } catch(e) {}
        }

        const scoreRelease = (release: any) => {
            let localScore = (release.seeders || 0) + ((release.peers || 0) * 0.5);
            const titleLower = release.title.toLowerCase();
            
            let appliedRules: string[] = [];

            for (const rule of scoringRules) {
                if (titleLower.includes(rule.term.toLowerCase())) {
                    localScore += rule.score;
                    appliedRules.push(`${rule.term}(${rule.score > 0 ? '+' : ''}${rule.score})`);
                }
            }
            
            Logger.log(`[Automation Debug] Scored Prowlarr release "${release.title}": Base Seed/Peer Score: ${(release.seeders || 0) + ((release.peers || 0) * 0.5)}, Applied Rules: [${appliedRules.join(', ')}], Final Score: ${localScore}`, 'debug');
            
            return localScore;
        };

        healthyResults.sort((a: any, b: any) => scoreRelease(b) - scoreRelease(a));
        const best = healthyResults[0];
        
        const clientConfig = await getDownloadClient(best.protocol);
        if (clientConfig) {
          const trackingHash = best.infoHash || best.guid || null;
          if (trackingHash) {
              const duplicateDownload = await prisma.request.findFirst({
                  where: {
                      downloadLink: trackingHash,
                      status: { in: ['DOWNLOADING', 'IMPORTED', 'COMPLETED'] },
                      id: { not: requestId }
                  }
              });
              if (duplicateDownload) {
                   Logger.log(`[Automation] Batch torrent already downloading (${trackingHash}). Queuing for batch extraction.`, 'info');
                   await prisma.request.update({ where: { id: requestId }, data: { status: 'DOWNLOADING', activeDownloadName: best.title, downloadLink: trackingHash, indexer: best.indexer } });
                   return;
              }
          }
          Logger.log(`[Automation] Sending to Client: ${clientConfig.name} for ${best.title}`, 'info');
          await DownloadService.addDownload(clientConfig, best.downloadUrl, best.title, best.seedTime || 0, best.seedRatio || 0);
          await prisma.request.update({ where: { id: requestId }, data: { status: 'DOWNLOADING', activeDownloadName: best.title, downloadLink: trackingHash, indexer: best.indexer } });
          return; 
        }
      }
  }

  if (fallbackManualUrl && enabledHosters.includes('getcomics')) {
      Logger.log(`[Automation] Prowlarr failed. Reverting to GetComics Manual DDL fallback.`, 'warn');
      await prisma.request.update({ where: { id: requestId }, data: { status: 'MANUAL_DDL', downloadLink: fallbackManualUrl, activeDownloadName: fallbackManualName } });
      return;
  }

  const currentReq = await prisma.request.findUnique({ where: { id: requestId }, include: { user: true } });
  if (currentReq?.status !== 'MANUAL_DDL' && currentReq?.status !== 'DOWNLOADING') {
      Logger.log(`[Automation] No results found anywhere for: ${name}`, 'warn');
      await prisma.request.update({ where: { id: requestId }, data: { status: 'STALLED' } });
      await SystemNotifier.sendAlert('download_failed', {
          title: name, imageUrl: currentReq?.imageUrl, user: currentReq?.user?.username,
          description: `Omnibus searched all connected indexers and direct download sites but could not find a match for **${name}**.`,
          publisher: publisher, year: year
      }).catch(() => {});
  }
}

export async function processAutomationQueue(items: any[]) {
  for (const item of items) {
    await searchAndDownload(item.id, item.name, item.year, item.publisher, item.isManga, item.skipIndexers);
  }
}