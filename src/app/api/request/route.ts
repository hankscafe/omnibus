import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import axios from 'axios';
import { DiscordNotifier } from '@/lib/discord';
import { Mailer } from '@/lib/mailer';
import { evaluateTrophies } from '@/lib/trophy-evaluator'; 
import { detectManga } from '@/lib/manga-detector'; 
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload, processAutomationQueue } from '@/lib/automation';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (token.id || token.sub) as string;
  if (!userId) return NextResponse.json({ error: 'Invalid user token' }, { status: 401 });

  const userExists = await prisma.user.findUnique({ where: { id: userId } });
  if (!userExists) {
      return NextResponse.json({ error: 'Your session is invalid. Please log out and log back in.' }, { status: 401 });
  }

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
          const libraries = await prisma.library.findMany();
          let targetLib = isManga 
              ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
              : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
          if (!targetLib) targetLib = libraries[0];

          const safeFolderName = name.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
          const safePubFolder = safePublisher.replace(/[<>:"/\\|?*]/g, '').trim();

          await prisma.series.upsert({
              where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: cvId.toString() } },
              update: { monitored: true, coverUrl: image },
              create: { 
                  metadataId: cvId.toString(), 
                  metadataSource: 'COMICVINE',
                  name, 
                  year: parseInt(year) || new Date().getFullYear(), 
                  publisher: safePublisher, 
                  folderPath: targetLib ? `${targetLib.path}/${safePubFolder}/${safeFolderName}` : `/${libraryTypeFolder}/${safePubFolder}/${safeFolderName}`, 
                  monitored: true,
                  isManga: isManga,
                  libraryId: targetLib?.id,
                  coverUrl: image
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
          
          Mailer.sendAlert('pending_request', { 
              user: token.name as string, 
              title: name,
              imageUrl: image,
              description: description,
              date: new Date().toLocaleString()
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
              userId: userId,
              volumeId: cvId.toString(),
              status: issueStatus,
              activeDownloadName: searchName,
              imageUrl: issueImage,
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

      evaluateTrophies(userId).catch(err => {
          Logger.log(`Trophy evaluation failed: ${getErrorMessage(err)}`, 'error');
      });

      return NextResponse.json({ 
        success: true, 
        message: initialStatus === 'PENDING' ? `Queued ${createdRequests.length} issues.` : "Sent for Admin approval." 
      });

    } else {
      const newReq = await prisma.request.create({
        data: {
          userId: userId,
          volumeId: cvId.toString(),
          status: initialStatus,
          activeDownloadName: name,
          imageUrl: image,
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
          
          Mailer.sendAlert('pending_request', { 
              user: token.name as string, 
              title: name,
              imageUrl: image,
              description: description,
              date: new Date().toLocaleString()
          }).catch(() => {});
      }

      if (initialStatus === 'PENDING') {
        searchAndDownload(newReq.id, name, year, safePublisher, isManga, skipIndexers).catch(e => Logger.log(getErrorMessage(e), 'error'));
      }

      evaluateTrophies(userId).catch(err => {
          Logger.log(`Trophy evaluation failed: ${getErrorMessage(err)}`, 'error');
      });

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

  const userId = (token.id || token.sub) as string;

  try {
    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    const reqRecord = await prisma.request.findUnique({ where: { id }, include: { user: true } });
    if (!reqRecord) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    const skipIndexers = reqRecord.downloadLink === 'DIRECT_GETCOMICS';

    await prisma.request.update({
      where: { id },
      data: { status }
    });

    if (status === 'PENDING') {
      let year = "";
      let publisher = "";
      let description = "";
      
      if (reqRecord.volumeId && reqRecord.volumeId !== "0") {
         const series = await prisma.series.findFirst({ where: { metadataId: reqRecord.volumeId, metadataSource: 'COMICVINE' } });
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
      
      Mailer.sendAlert('request_approved', { 
          user: token.name as string, 
          requester: reqRecord.user?.username || "Unknown",
          title: searchName || reqRecord.volumeId || "Unknown Comic",
          email: reqRecord.user?.email,
          imageUrl: reqRecord.imageUrl,
          description: description,
          date: new Date().toLocaleString()
      }).catch(() => {});

      const isManga = await detectManga({ name: searchName, publisher: { name: publisher } });
      const fallbackMatches = [...searchName.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
      
      searchAndDownload(id, searchName, year, publisher, isManga, skipIndexers).catch(e => Logger.log(getErrorMessage(e), 'error'));
    }

    evaluateTrophies(userId).catch(err => {
        Logger.log(`Trophy evaluation failed: ${getErrorMessage(err)}`, 'error');
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log(`[Request API] Approval Error: ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}