import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import axios from 'axios';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { DownloadService } from '@/lib/download-clients';
import { DiscordNotifier } from '@/lib/discord';
import { evaluateTrophies } from '@/lib/trophy-evaluator'; 
import { detectManga } from '@/lib/manga-detector'; 
import { getCustomAcronyms, generateSearchQueries } from '@/lib/search-engine'; 
import { Importer } from '@/lib/importer';

export const dynamic = 'force-dynamic';

// --- NEW: Helper to check if an issue is actually released ---
function isReleasedYet(storeDate: string | null, coverDate: string | null) {
  const now = new Date();
  if (storeDate) {
    return new Date(storeDate) <= now;
  }
  if (coverDate) {
    // Comic cover dates are usually printed 1-2 months ahead of physical release.
    const buffer = new Date();
    buffer.setDate(buffer.getDate() + 45); 
    return new Date(coverDate) <= buffer;
  }
  return true; // If CV has no date, assume it's out
}

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { cvId, name, year, type, image, monitored } = body; 
    let { publisher, description } = body;

    if (!cvId || !name) return NextResponse.json({ error: 'Missing metadata' }, { status: 400 });

    const initialStatus = token.autoApproveRequests ? 'PENDING' : 'PENDING_APPROVAL';

    if (!publisher || publisher === "Unknown" || publisher === "Other" || !description) {
        try {
            const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            if (cvKeySetting?.value) {
                const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
                    params: { api_key: cvKeySetting.value, format: 'json', field_list: 'publisher,description,deck' },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 4000
                });
                const volData = cvVolRes.data?.results;
                if (volData) {
                    if (!publisher || publisher === "Unknown" || publisher === "Other") {
                        publisher = volData.publisher?.name;
                    }
                    if (!description) {
                        description = volData.description || volData.deck;
                    }
                }
            }
        } catch (e) {}
    }

    const safePublisher = publisher || "Unknown";
    const isManga = await detectManga({ name, publisher: { name: safePublisher }, year: parseInt(year) });
    const libraryTypeFolder = isManga ? 'Manga' : 'Comics';

    if (type === 'volume') {
      Logger.log(`[Request] User ${token.name} requested full Volume: ${name}`, 'info');
      
      if (monitored) {
          const safeFolderName = name.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
          const safePubFolder = safePublisher.replace(/[<>:"/\\|?*]/g, '').trim();

          await prisma.series.upsert({
              where: { cvId: parseInt(cvId) },
              update: { monitored: true },
              create: { 
                  cvId: parseInt(cvId), 
                  name, 
                  year: parseInt(year) || new Date().getFullYear(), 
                  publisher: safePublisher, 
                  folderPath: `/${libraryTypeFolder}/${safePubFolder}/${safeFolderName}`, 
                  monitored: true 
              }
          });
          Logger.log(`[Monitoring] ${name} is now actively being monitored.`, 'success');
      }

      if (initialStatus === 'PENDING_APPROVAL') {
          DiscordNotifier.sendAlert('pending_request', {
              title: name,
              imageUrl: image,
              user: token.name as string,
              description: description,
              publisher: safePublisher,
              year: year
          }).catch(() => {});
      }

      const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
      const cvApiKey = cvKeySetting?.value;
      
      if (!cvApiKey) throw new Error("Missing ComicVine API Key");

      const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
        params: {
          api_key: cvApiKey,
          format: 'json',
          filter: `volume:${cvId}`,
          field_list: 'id,name,issue_number,cover_date,store_date,image' 
        },
        headers: { 'User-Agent': 'Omnibus/1.0' }
      });

      const issues = cvRes.data.results || [];
      const createdRequests = [];

      for (const issue of issues) {
        const issueYear = (issue.store_date || issue.cover_date || year || "").split('-')[0];
        const searchName = `${name} #${issue.issue_number}`;
        const issueImage = issue.image?.medium_url || issue.image?.small_url || image;

        // --- NEW: Check Release Date ---
        const isReleased = isReleasedYet(issue.store_date, issue.cover_date);
        let issueStatus = initialStatus;
        
        // If it's not released, force it to UNRELEASED so it bypasses search entirely
        if (!isReleased) {
            issueStatus = 'UNRELEASED';
        }

        const existing = await prisma.request.findFirst({
          where: { volumeId: cvId.toString(), activeDownloadName: searchName }
        });

        if (!existing) {
          const newReq = await prisma.request.create({
            data: {
              userId: token.id as string,
              volumeId: cvId.toString(),
              status: issueStatus,
              activeDownloadName: searchName,
              imageUrl: issueImage 
            }
          });
          
          // Only push to the automation queue if it's PENDING and actually released
          if (issueStatus === 'PENDING') {
            createdRequests.push({ id: newReq.id, name: searchName, year: issueYear, publisher: safePublisher, isManga });
          }
        }
      }

      if (createdRequests.length > 0) {
        processAutomationQueue(createdRequests);
      }

      evaluateTrophies(token.id as string).catch(console.error);

      return NextResponse.json({ 
        success: true, 
        message: initialStatus === 'PENDING' ? `Queued ${createdRequests.length} issues.` : "Sent for Admin approval." 
      });

    } else {
      // Logic for single issue request (assumes it's out since the user specifically clicked it)
      const newReq = await prisma.request.create({
        data: {
          userId: token.id as string,
          volumeId: cvId.toString(),
          status: initialStatus,
          activeDownloadName: name,
          imageUrl: image 
        }
      });

      if (initialStatus === 'PENDING_APPROVAL') {
          DiscordNotifier.sendAlert('pending_request', {
              title: name,
              imageUrl: image,
              user: token.name as string,
              description: description,
              publisher: safePublisher,
              year: year
          }).catch(() => {});
      }

      if (initialStatus === 'PENDING') {
        searchAndDownload(newReq.id, name, year, safePublisher, isManga).catch(e => console.error(e));
      }

      evaluateTrophies(token.id as string).catch(console.error);

      return NextResponse.json({ 
        success: true, 
        message: initialStatus === 'PENDING' ? "Download started." : "Pending Admin approval." 
      });
    }

  } catch (error: any) {
    Logger.log(`[Request Error] ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token || token.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    const reqRecord = await prisma.request.findUnique({ where: { id } });
    if (!reqRecord) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    await prisma.request.update({
      where: { id },
      data: { status }
    });

    if (status === 'PENDING') {
      let year = "";
      let publisher = "";
      let description = "";
      
      if (reqRecord.volumeId) {
         const series = await prisma.series.findFirst({ where: { cvId: parseInt(reqRecord.volumeId) } });
         if (series) {
             year = series.year.toString();
             publisher = series.publisher || "Unknown";
             description = series.description || "";
         }
      }
      
      const searchName = reqRecord.activeDownloadName || "";
      Logger.log(`[Request] Admin approved request: ${searchName}`, 'info');

      DiscordNotifier.sendAlert('request_approved', {
          title: searchName || reqRecord.volumeId || "Unknown Comic",
          imageUrl: reqRecord.imageUrl,
          user: token.name as string,
          description: description,
          publisher: publisher,
          year: year 
      }).catch(() => {});

      const isManga = await detectManga({ name: searchName, publisher: { name: publisher } });
      searchAndDownload(id, searchName, year, publisher, isManga).catch(e => console.error(e));
    }

    evaluateTrophies(token.id as string).catch(console.error);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log(`[Request API] Approval Error: ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * AUTOMATION
 */

async function processAutomationQueue(items: any[]) {
  for (const item of items) {
    try {
      await searchAndDownload(item.id, item.name, item.year, item.publisher, item.isManga);
      await new Promise(r => setTimeout(r, 5000)); 
    } catch (e) {
      console.error(`Automation failed for ${item.name}`);
    }
  }
}

async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false) {
  const acronyms = await getCustomAcronyms();
  const queries = generateSearchQueries(name, year, acronyms);
  
  Logger.log(`[Automation] Generated ${queries.length} search variations for: ${name}`, 'info');
  
  let healthyResults: any[] = [];
  let successfulQuery = "";

  for (const query of queries) {
      Logger.log(`[Automation] Searching Prowlarr: "${query}"`, 'info');
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
      Logger.log(`[Automation] Sending to Client: ${best.title} (Priority: ${best.priority})`, 'info');
      await DownloadService.addDownload(config, best.downloadUrl, best.title, best.seedTime || 0, best.seedRatio || 0);
      
      const trackingHash = best.infoHash || best.guid || null;
      
      await prisma.request.update({
        where: { id: requestId },
        data: { 
          status: 'DOWNLOADING', 
          activeDownloadName: best.title, 
          downloadLink: trackingHash 
        }
      });
      return; 
    }
  }

  Logger.log(`[Automation] Not found on Indexers. Falling back to GetComics...`, 'info');
  let getComicsResults: any[] = [];
  
  for (const query of queries) {
      Logger.log(`[Automation] Searching GetComics: "${query}"`, 'info');
      getComicsResults = await GetComicsService.search(query);
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
        data: { 
            status: 'DOWNLOADING',
            activeDownloadName: safeTitle 
        }
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
     Logger.log(`[Automation] No results found anywhere for: ${name}`, 'warn');
  }
}

async function getDownloadClient() {
  const clients = await prisma.downloadClient.findMany();
  return clients.length > 0 ? clients[0] : null;
}