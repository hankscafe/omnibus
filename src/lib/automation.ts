// src/lib/automation.ts
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getCustomAcronyms, generateSearchQueries, normalizeRequestName } from '@/lib/search-engine';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService, enabledHostersFromSetting } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { Importer } from '@/lib/importer';
import { getErrorMessage } from './utils/error';
import { SystemNotifier } from '@/lib/notifications';
import { isSameIssue, extractIssueNumber, parseIssueRange } from '@/lib/utils/issue-parser';
import { STOP_WORDS } from '@/lib/utils/search-terms';
import { DEFAULT_SCORING_RULES } from '@/lib/utils/defaults';

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

  // --- START OF ISSUE YEAR OPTIMIZATION & PACK ISOLATION ---
  let dynamicYear = year;
  let allowPacksForThisRequest = false;
  // Authoritative series name from metadata (ComicVine/Metron), captured for the indexer relevance guard
  // below so "which series did we ask for" is judged against the canonical name — not a delimiter-split
  // guess or a stale activeDownloadName. Stays null for manual (non-metadata) requests.
  let canonicalSeriesName: string | null = null;

  if (freshReq.volumeId && freshReq.volumeId !== "0") {
      const reqSource = (freshReq as any).metadataSource || 'COMICVINE';

      const localSeries = await prisma.series.findFirst({
          where: {
              metadataId: freshReq.volumeId,
              metadataSource: reqSource
          }
      });

      if (localSeries) {
          canonicalSeriesName = localSeries.name || null;
          // Check the database to see if we ALREADY have downloaded files for this series
          const downloadedIssuesCount = await prisma.issue.count({
              where: { seriesId: localSeries.id, filePath: { not: null } }
          });

          // --- FIX: Remove the 'monitored' requirement. If they own 0 files, ALWAYS allow packs ---
          if (downloadedIssuesCount === 0) {
              allowPacksForThisRequest = true;
          }

          const cleanReqName = (freshReq.activeDownloadName || name).replace(/\.\w+$/, '');
          const issueNumMatch = cleanReqName.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?[a-zA-Z]?)/i);
          
          if (issueNumMatch) {
              const targetIssueNum = issueNumMatch[1];
              const allSeriesIssues = await prisma.issue.findMany({
                  where: { seriesId: localSeries.id }
              });

              const issueSkeleton = allSeriesIssues.find(i => isSameIssue(i.number, targetIssueNum));

              if (issueSkeleton && issueSkeleton.releaseDate) {
                  const parsedIssueYear = issueSkeleton.releaseDate.split('-')[0];
                  if (parsedIssueYear && parsedIssueYear.match(/^\d{4}$/) && parsedIssueYear !== dynamicYear) {
                      Logger.log(`[Automation] Overriding series year (${dynamicYear}) with accurate issue release year (${parsedIssueYear}) for ${name}`, 'info');
                      dynamicYear = parsedIssueYear;
                  }
              }
          }
      }
  }
  // --- END OF ISSUE YEAR OPTIMIZATION & PACK ISOLATION ---

  // Parse the blocklist for failed downloads
  let failedItems: string[] = [];
  try { failedItems = JSON.parse((freshReq as any).failedLinks || "[]"); } catch(e) {}
  
  await prisma.request.update({
      where: { id: requestId },
      data: { status: 'PENDING' }
  });

  let searchName = name;
   const subtitleMatch = name.match(/(.*?(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+(?:\.\d+)?)\s*[:\-]\s*.*/i);
   if (subtitleMatch) {
       searchName = subtitleMatch[1].trim();
   }

   // --- PRESERVE MOCK SEQUENCE: Fetch hoster settings FIRST ---
   const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
   const ddlSetting = await prisma.systemSetting.findUnique({ where: { key: 'ddl_enabled' } });

   // --- Fetch Pack Settings & Evaluate AFTER ---
   const bulkSetting = await prisma.systemSetting.findUnique({ where: { key: 'allow_bulk_packs' } });
   const prioritizeSetting = await prisma.systemSetting.findUnique({ where: { key: 'prioritize_packs' } });
   const globalAllowBulk = bulkSetting?.value === 'true';
   const globalPrioritize = prioritizeSetting?.value === 'true';
   const usePacks = globalAllowBulk && allowPacksForThisRequest;
   const prioritizePacks = globalPrioritize && usePacks;

   const acronyms = await getCustomAcronyms();
   const queries = generateSearchQueries(searchName, year, acronyms, isManga, prioritizePacks, usePacks);
   Logger.log(`[Automation Debug] Generated queries for "${name}": ${JSON.stringify(queries)}`, 'debug');

   const ddlEnabled = ddlSetting?.value !== 'false';
   // Resolve the enabled hoster list through the SAME parser+migration getcomics.ts uses, so the legacy
   // single `getcomics` key is split into `getcomics_direct` + `getcomics_main` here too. This block used
   // to parse the raw setting on its own and default to the obsolete `getcomics` token — so the gate below
   // never recognized the `getcomics_main`/`getcomics_direct` hosters scrapeDeepLink actually returns, and
   // every GetComics direct download was wrongly rejected as "unsupported" and dumped onto the indexers.
   const enabledHosters = enabledHostersFromSetting(hpSetting?.value);
   const hasEnabledHosters = enabledHosters.length > 0;
  
  let getComicsResults: any[] = [];
  let fallbackManualUrl: string | null = null;
  let fallbackManualName: string | null = null;

  if (ddlEnabled && hasEnabledHosters) {
      Logger.log(`[Automation] Priority Phase: Searching GetComics...`, 'info');
      for (const query of queries) {
          // Detect if this query is a broad/pack search (lacks an issue number)
          const isPackQuery = !query.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+/i);
          const activeYear = isPackQuery ? year : dynamicYear;

          const rawGetComicsResults = (await GetComicsService.search(query, false, isManga, name, activeYear, usePacks)) || [];
          
          // BLOCKLIST CHECK: Filter out releases where the Title or URL has failed before
          getComicsResults = rawGetComicsResults.filter((r: any) => {
              const isFailed = failedItems.includes(r.title) || failedItems.includes(r.downloadUrl);
              if (isFailed) {
                  Logger.log(`[Automation Debug] Skipping blocklisted GetComics release: "${r.title}"`, 'debug');
              }
              return !isFailed;
          });
          
          Logger.log(`[Automation Debug] GetComics search for "${query}" returned ${getComicsResults.length} unblocked results.`, 'debug');
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
            // Parse the requested issue number so a multi-pack GetComics article (e.g. a "Crossed
            // Collection" listing several separate archives) can be section-targeted to the archive that
            // actually contains it. dynamicYear disambiguates same-numbered issues across volumes.
            const reqNumMatch = (freshReq.activeDownloadName || name).match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)/i);
            const targetIssueNum = reqNumMatch ? parseFloat(reqNumMatch[1]) : null;
            const deepLink = await GetComicsService.scrapeDeepLink(best.downloadUrl, { issueNum: targetIssueNum, year: dynamicYear });

            if (deepLink.ambiguous) {
                Logger.log(`[Automation] [GetComics] "${best.title}" is a multi-pack page and no single archive cleanly matched issue #${targetIssueNum}. Holding for admin review.`, 'warn');
                const ambiguousReq = await prisma.request.findUnique({ where: { id: requestId }, include: { user: true } });
                await prisma.request.update({ where: { id: requestId }, data: { status: 'STALLED', downloadLink: best.downloadUrl, activeDownloadName: best.title } });
                await SystemNotifier.sendAlert('download_failed', {
                    title: name, imageUrl: ambiguousReq?.imageUrl, user: ambiguousReq?.user?.username,
                    description: `GetComics lists **${name}** only on a multi-pack page with several separate archives. Please use Interactive Search in the Active Downloads queue to select the correct archive.`,
                    publisher: publisher, year: year
                }).catch(() => {});
                return;
            }

            const { url, hoster } = deepLink;
            const safeTitle = best.title.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
            
            // getcomics_main is the Cloudflare-protected getcomics.org/dls/ link. Node can't pass the CF
            // challenge (auto-FlareSolverr streaming was engine-only), so an Internal DL always 403s — exactly
            // the Wolverine #3 failure. Treat it as manual-only: hold the link, let Prowlarr try for an auto
            // grab, and end as a one-click MANUAL_DDL if the indexers come up empty. getcomics_direct (clean
            // CDN) still auto-downloads. (Before beta.051 BOTH were unrecognized and fell to this branch; the
            // hoster-gate fix correctly enabled getcomics_direct but also started dispatching getcomics_main.)
            const isCloudflareMain = hoster === 'getcomics_main';
            if (enabledHosters.includes(hoster) && !isCloudflareMain) {
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
              const reason = isCloudflareMain
                  ? `a Cloudflare-protected getcomics_main /dls/ link (not auto-downloadable in Node)`
                  : `an unsupported/disabled hoster (${hoster})`;
              Logger.log(`[Automation] [GetComics] Best match is ${reason}. Holding manual link and falling back to Prowlarr...`, 'warn');
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

      // Relevance guard anchored to the ORIGINAL request, not the query that happened to return results.
      // Prowlarr's per-query filter disables its issue gate whenever the query carries no issue number, so
      // a broad fallback like "X Men 2026" (e.g. from a colon-split "X-Men: Outback #1") lets every X-Men
      // issue through and the scorer then grabs an arbitrary one. This re-checks each release against the
      // requested SERIES words and ISSUE number so the wrong series/issue can never be selected.
      const reqClean = normalizeRequestName(name);
      const reqIssueMatch = reqClean.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)/i);
      const requestedIssue = reqIssueMatch ? reqIssueMatch[1] : null;
      // Judge "which series" against the AUTHORITATIVE metadata name when we have it, so a series whose
      // name contains ':' or '-' (e.g. "X-Men: Outback") is enforced IN FULL and never reduced to a
      // droppable prefix. Delimiters are normalized to spaces on both sides, so ":"/"-"/" - " variants
      // compare equal. Manual (non-metadata) requests fall back to the parsed request name.
      const seriesNameForMatch = canonicalSeriesName
          || reqClean.replace(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*-?\d+(?:\.\d+)?.*$/i, '');
      const reqSeriesTokens = seriesNameForMatch
          .replace(/\b(19|20)\d{2}\b/g, ' ')
          .replace(/[^a-zA-Z0-9\s]/g, ' ')
          .toLowerCase()
          .split(/\s+/)
          .filter((t: string) => t.length > 2 && !STOP_WORDS.includes(t));

      const matchesRequest = (title: string): boolean => {
          const titleLower = (title || '').toLowerCase();
          // Every significant series word from the request must be present (the same mandatory-word
          // intersection Prowlarr applies per-query, but anchored to the request so a broad query can't
          // relax it — this is what rejects a different series like "X-Men 031" for "X-Men: Outback").
          if (reqSeriesTokens.length > 0 && !reqSeriesTokens.every((t: string) => titleLower.includes(t))) return false;
          // A single-issue request must land on that exact issue (or a pack/range that contains it).
          if (requestedIssue !== null && !usePacks) {
              const range = parseIssueRange(titleLower);
              if (range) {
                  const n = parseFloat(requestedIssue);
                  if (Number.isFinite(n) && (n < range.start || n > range.end)) return false;
              } else if (!isSameIssue(extractIssueNumber(title), requestedIssue)) {
                  return false;
              }
          }
          return true;
      };

      let healthyResults: any[] = [];
      for (const query of queries) {
          // Detect if this query is a broad/pack search (lacks an issue number)
          const isPackQuery = !query.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*\d+/i);
          const activeYear = isPackQuery ? year : dynamicYear;

          // Pass `usePacks` down to Prowlarr to prevent torrent pack leaks
          const prowlarrResults = (await ProwlarrService.searchComics(query, false, isManga, activeYear, usePacks)) || [];
          
          healthyResults = prowlarrResults.filter((r: any) => {
              const isHealthy = r.seeders > 0 || r.protocol === 'usenet';
              const trackingHash = r.infoHash || r.guid || r.downloadUrl;

              // BLOCKLIST CHECK: Filter out titles, hashes, or URLs that have failed
              const isFailed = failedItems.includes(r.title) || failedItems.includes(trackingHash);

              if (isFailed) {
                  Logger.log(`[Automation Debug] Skipping blocklisted Prowlarr release: "${r.title}"`, 'debug');
              }

              // RELEVANCE GUARD: reject wrong-series/wrong-issue releases that a broad query let through, so
              // a query yielding only mismatches no longer short-circuits the more specific queries below.
              const isRelevant = matchesRequest(r.title);
              if (isHealthy && !isFailed && !isRelevant) {
                  Logger.log(`[Automation Debug] Discarding off-target Prowlarr release "${r.title}" (does not match requested "${reqClean}").`, 'debug');
              }

              return isHealthy && !isFailed && isRelevant;
          });

          if (healthyResults.length > 0) break;
          await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (healthyResults.length > 0) {
        const scoringSetting = await prisma.systemSetting.findUnique({ where: { key: 'release_scoring_rules' } });
        let scoringRules = [...DEFAULT_SCORING_RULES];

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
            
            const appliedRules: string[] = [];

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

  if (fallbackManualUrl && enabledHosters.some(h => h.startsWith('getcomics'))) {
      Logger.log(`[Automation] Prowlarr failed. Reverting to GetComics Manual DDL fallback.`, 'warn');
      await prisma.request.update({ where: { id: requestId }, data: { status: 'MANUAL_DDL', downloadLink: fallbackManualUrl, activeDownloadName: fallbackManualName } });
      return;
  }

  // Anna's Archive automation fallback (opt-in via search_source_priority): GetComics + Prowlarr found
  // nothing, so if Anna's is an enabled automation source, surface its best match into the manual queue
  // (MANUAL_DDL) for one-click admin pickup via the request/manual annas_archive flow.
  // NOTE: net-new on the Node branch (rust-engine auto-streamed this in the engine with its own scorer);
  // it holds for manual review here rather than auto-downloading a possible mismatch — tune on a live deploy.
  try {
      const sspSetting = await prisma.systemSetting.findUnique({ where: { key: 'search_source_priority' } });
      const ssp = sspSetting?.value ? JSON.parse(sspSetting.value) : [];
      const annasAutomation = Array.isArray(ssp) && ssp.some((s: any) => s?.source === 'annas_archive' && s?.enabled);
      if (annasAutomation) {
          const { searchAnnasArchive } = await import('@/lib/hosters/annas-archive');
          const annasResults = await searchAnnasArchive(queries, false, isManga).catch(() => []);
          const nameTokens = normalizeRequestName(name).split(/\s+/).filter((t: string) => t.length > 2);
          const match = annasResults.find((r: any) => {
              const t = (r.title || '').toLowerCase();
              return nameTokens.length > 0 && nameTokens.every((tok: string) => t.includes(tok));
          });
          if (match?.downloadUrl) {
              Logger.log(`[Automation] Anna's Archive fallback: surfacing "${match.title}" to the manual queue.`, 'info');
              await prisma.request.update({ where: { id: requestId }, data: { status: 'MANUAL_DDL', downloadLink: match.downloadUrl, activeDownloadName: match.title } });
              return;
          }
      }
  } catch (e) { Logger.log(`[Automation] Anna's Archive fallback failed: ${getErrorMessage(e)}`, 'warn'); }

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