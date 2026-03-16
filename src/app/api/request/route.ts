import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import axios from 'axios';
import { DiscordNotifier } from '@/lib/discord';
import { evaluateTrophies } from '@/lib/trophy-evaluator'; 
import { detectManga } from '@/lib/manga-detector'; 
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload, processAutomationQueue } from '@/lib/automation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const { cvId, name, year, type, image, monitored, directSource } = body; 
    let { publisher, description } = body;

    const skipIndexers = directSource === 'getcomics';

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

        const isReleased = isReleasedYet(issue.store_date, issue.cover_date);
        let issueStatus = initialStatus;
        
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
              imageUrl: issueImage,
              // Inject a temporary flag if pending approval
              downloadLink: skipIndexers && issueStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null 
            }
          });
          
          if (issueStatus === 'PENDING') {
            createdRequests.push({ id: newReq.id, name: searchName, year: issueYear, publisher: safePublisher, isManga, skipIndexers });
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
      const newReq = await prisma.request.create({
        data: {
          userId: token.id as string,
          volumeId: cvId.toString(),
          status: initialStatus,
          activeDownloadName: name,
          imageUrl: image,
          // Inject a temporary flag if pending approval
          downloadLink: skipIndexers && initialStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null
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
        searchAndDownload(newReq.id, name, year, safePublisher, isManga, skipIndexers).catch(e => console.error(e));
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

    // Check if the temporary GetComics flag was attached during the original request
    const skipIndexers = reqRecord.downloadLink === 'DIRECT_GETCOMICS';

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
      
      // Pass the extracted skipIndexers flag directly into the search queue
      searchAndDownload(id, searchName, year, publisher, isManga, skipIndexers).catch(e => console.error(e));
    }

    evaluateTrophies(token.id as string).catch(console.error);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log(`[Request API] Approval Error: ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}