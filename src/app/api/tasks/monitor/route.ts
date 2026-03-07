import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import axios from 'axios';

// Imports required for direct background execution
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { Importer } from '@/lib/importer';

export const dynamic = 'force-dynamic';

async function getDownloadClient() {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'download_clients_config' } });
    if (!setting?.value) return null;
    const clients = JSON.parse(setting.value);
    return clients.length > 0 ? clients[0] : null;
}

async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false) {
    const acronyms = await getCustomAcronyms();
    const queries = generateSearchQueries(name, year, acronyms);
    
    Logger.log(`[Automation] Generated ${queries.length} search variations for: ${name}`, 'info');
    
    let healthyResults: any[] = [];
    let successfulQuery = "";

    for (const query of queries) {
        const prowlarrResults = await ProwlarrService.searchComics(query);
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
        await DownloadService.addDownload(config, best.downloadUrl, best.title, best.seedTime || 0, best.seedRatio || 0);
        const trackingHash = best.infoHash || best.guid || null;
        
        await prisma.request.update({
          where: { id: requestId },
          data: { status: 'DOWNLOADING', activeDownloadName: best.title, downloadLink: trackingHash }
      });
        return; 
      }
    }

    let getComicsResults: any[] = [];
    for (const query of queries) {
        getComicsResults = await GetComicsService.search(query);
        if (getComicsResults.length > 0) break;
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
          .catch(e => console.error(e));
      } else {
        await prisma.request.update({
          where: { id: requestId },
          data: { status: 'MANUAL_DDL', downloadLink: url }
        });
      }
    } else {
       await prisma.request.update({
          where: { id: requestId },
          data: { status: 'STALLED' }
       });
    }
}

export async function POST() {
  try {
    Logger.log('[Monitor Task] Starting scan for monitored series...', 'info');
    
    const monitoredSeries = await prisma.series.findMany({
      where: { monitored: true },
      include: { issues: true }
    });

    if (monitoredSeries.length === 0) {
      Logger.log("[Monitor Task] No series are marked as 'Monitored' in your database.", "warn");
      return NextResponse.json({ success: true, message: 'No monitored series found.' });
    }

    Logger.log(`[Monitor Task] Found ${monitoredSeries.length} series to check.`, "info");

    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!cvKeySetting?.value) throw new Error("Missing ComicVine API Key");

    let newIssuesFound = 0;

    for (const series of monitoredSeries) {
      try {
        Logger.log(`[Monitor Task] Checking CV for: ${series.name}`, 'info');
        
        let offset = 0;
        let totalResults = 1;
        let loopCount = 0;
        const allCvIssues = [];

        while (offset < totalResults && loopCount < 20) {
            // CACHE BUSTER: Sort by store_date descending
            const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
              params: {
                api_key: cvKeySetting.value, format: 'json', filter: `volume:${series.cvId}`,
                sort: 'store_date:desc', limit: 100, offset: offset,
                field_list: 'id,name,issue_number,cover_date,store_date,image' 
              },
              headers: { 'User-Agent': 'Omnibus/1.0' }
            });

            if (offset === 0) totalResults = cvRes.data.number_of_total_results || 0;
            const cvIssues = cvRes.data.results || [];
            allCvIssues.push(...cvIssues);
            
            offset += 100;
            loopCount++;
            await new Promise(r => setTimeout(r, 1500));
        }

        Logger.log(`[Monitor Task] ComicVine returned ${allCvIssues.length} issues for ${series.name}`, 'info');

        const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        const existingRequests = await prisma.request.findMany({
            where: { volumeId: series.cvId.toString() }
        });

        let seriesNewCount = 0;

        for (const cvIssue of allCvIssues) {
            const cvNum = parseFloat(cvIssue.issue_number);
            if (isNaN(cvNum)) continue;

            // 1. Check Issue Table
            const alreadyInLibrary = series.issues.some(i => 
                parseFloat(i.number) === cvNum && 
                i.filePath && 
                i.filePath.length > 0
                );
            if (alreadyInLibrary) continue;

            // 2. Check Request Table Thoroughly
            const searchName = `${series.name} #${cvIssue.issue_number}`;
            
            const alreadyReq = existingRequests.find(r => {
                if (r.activeDownloadName === searchName) return true;
                const match = (r.activeDownloadName || "").match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                if (match && parseFloat(match[1]) === cvNum) return true;
                return false;
            });

            if (alreadyReq) {
                Logger.log(`[Monitor Task] Skipping ${searchName} - Already in Request Queue (Status: ${alreadyReq.status})`, 'info');
                continue;
            }

            // IT'S TRULY NEW!
            Logger.log(`[Monitor Task] Found NEW missing issue: ${searchName}`, 'success');
            
            const issueImage = cvIssue.image?.medium_url || cvIssue.image?.small_url;
            const issueYear = (cvIssue.store_date || cvIssue.cover_date || series.year.toString() || "").split('-')[0];

            const newReq = await prisma.request.create({
              data: {
                userId: admin?.id || 'system',
                volumeId: series.cvId.toString(),
                status: 'PENDING',
                activeDownloadName: searchName,
                imageUrl: issueImage
              }
            });

            // Directly execute automation
            searchAndDownload(newReq.id, searchName, issueYear, series.publisher || "Unknown", (series as any).isManga)
                .catch(e => console.error("Monitor Automation Error:", e));

            newIssuesFound++;
            seriesNewCount++;
        }

        if (seriesNewCount === 0) {
            Logger.log(`[Monitor Task] No new issues needed for ${series.name}.`, 'info');
        }

      } catch (err) {
        Logger.log(`[Monitor Task] Failed to scan series ${series.name}`, 'error');
      }
    }

    return NextResponse.json({ success: true, message: `Scan complete. Queued ${newIssuesFound} new issues.` });

  } catch (error: any) {
    Logger.log(`[Monitor Task Error] ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}