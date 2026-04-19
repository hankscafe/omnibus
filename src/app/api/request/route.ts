// src/app/api/request/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import axios from 'axios';
// --- CHANGED: Using unified SystemNotifier instead of DiscordNotifier/Mailer ---
import { SystemNotifier } from '@/lib/notifications';
import { evaluateTrophies } from '@/lib/trophy-evaluator'; 
import { detectManga } from '@/lib/manga-detector'; 
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload, processAutomationQueue } from '@/lib/automation';
import { getErrorMessage } from '@/lib/utils/error';
import { syncSeriesMetadata } from '@/lib/metadata-fetcher'; 
import { AuditLogger } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

const getMetronCover = async (seriesName: string, issueNumber: string, user?: string, pass?: string) => {
    if (!user || !pass) return null;
    try {
        const res = await axios.get(`https://metron.cloud/api/issue/`, {
            params: { series_name: seriesName, number: issueNumber },
            auth: { username: user, password: pass },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 4000
        });
        return res.data?.results?.[0]?.image || null;
    } catch (e) {
        return null;
    }
};

export async function GET(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (token.id || token.sub) as string;

  try {
    const requests = await prisma.request.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    const volumeIds = Array.from(new Set(requests.map(r => r.volumeId)));
    const seriesList = await prisma.series.findMany({ 
        where: { metadataId: { in: volumeIds }, metadataSource: 'COMICVINE' } 
    });

    const metronUserSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
    const metronPassSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });

    const formattedRequests = await Promise.all(requests.map(async req => {
      const series = seriesList.find(s => s.metadataId === req.volumeId);
      let issueNumberStr = "";
      
      const regexMatch = req.activeDownloadName?.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
      if (regexMatch) issueNumberStr = ` Issue #${regexMatch[1].padStart(3, '0')}`;

      let finalImageUrl = req.imageUrl;

      if (req.status === 'UNRELEASED' && (!finalImageUrl || finalImageUrl.includes('placeholder') || finalImageUrl.includes('default'))) {
          const seriesNameStr = series?.name || req.activeDownloadName?.replace(/#.*/, '').trim();
          if (regexMatch && seriesNameStr) {
              const fallback = await getMetronCover(seriesNameStr, regexMatch[1], metronUserSetting?.value, metronPassSetting?.value);
              if (fallback) {
                  finalImageUrl = fallback;
                  prisma.request.update({ where: { id: req.id }, data: { imageUrl: fallback } }).catch(()=>{});
              }
          }
      }

      return {
        id: req.id,
        userId: req.userId,
        volumeId: req.volumeId, 
        seriesName: series ? `${series.name}${issueNumberStr} (${series.year})` : (req.activeDownloadName || `Volume ${req.volumeId}`), 
        userName: token.name || 'User',
        createdAt: req.createdAt,
        updatedAt: req.updatedAt,
        status: req.status,
        progress: req.progress, 
        downloadLink: req.downloadLink,
        imageUrl: finalImageUrl && finalImageUrl.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(finalImageUrl)}` : finalImageUrl,
        retryCount: req.retryCount || 0 
      };
    }));

    return NextResponse.json(formattedRequests);
  } catch (error: any) {
    Logger.log(`[User Requests API] Fetch Error: ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (token.id || token.sub) as string;
  if (!userId) return NextResponse.json({ error: 'Invalid user token' }, { status: 401 });

  const userExists = await prisma.user.findUnique({ where: { id: userId } });
  if (!userExists) {
      return NextResponse.json({ error: 'Your session is invalid. Please log out and log back in.' }, { status: 401 });
  }

  const metronUserSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
  const metronPassSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });

  try {
    const body = await request.json();
    let name = body.name || body.seriesName || body.title;
    const { cvId, type, monitored, directSource } = body; 
    let { image, publisher, year, description } = body;

    if (!cvId) return NextResponse.json({ error: 'Missing ComicVine ID' }, { status: 400 });

    if (!name || name === "Unknown" || type === 'volume' || !publisher || publisher === "Unknown" || !year) {
        try {
            const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            if (cvKeySetting?.value) {
                const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
                    params: { api_key: cvKeySetting.value, format: 'json', field_list: 'publisher,description,deck,name,start_year' },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 4000
                });
                const volData = cvVolRes.data?.results;
                if (volData) {
                    name = volData.name;
                    if (!publisher || publisher === "Unknown") publisher = volData.publisher?.name;
                    if (!year) year = volData.start_year;
                    if (!description) description = volData.description || volData.deck;
                }
            }
        } catch (e) {
            Logger.log(`[Request] Metadata recovery failed for CV:${cvId}`, 'warn');
        }
    }

    if (!name || name === "Unknown") {
        return NextResponse.json({ error: 'Series name unresolved. Please try Interactive Search.' }, { status: 400 });
    }

    const skipIndexers = directSource === 'getcomics';
    const initialStatus = token.autoApproveRequests ? 'PENDING' : 'PENDING_APPROVAL';

    const safePublisher = publisher || "Unknown";
    const isManga = await detectManga({ name, publisher: { name: safePublisher }, year: parseInt(year) });
    const libraryTypeFolder = isManga ? 'Manga' : 'Comics';

    if (type === 'volume') {
      Logger.log(`[Request] User ${token.name} requested full Volume: ${name}`, 'info');
      
      const libraries = await prisma.library.findMany();
      let targetLib = isManga 
          ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
          : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
      if (!targetLib) targetLib = libraries[0];

      const safeFolderName = name.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
      const safePubFolder = safePublisher.replace(/[<>:"/\\|?*]/g, '').trim();
      const folderPath = targetLib ? `${targetLib.path}/${safePubFolder}/${safeFolderName} (${year})` : `/${libraryTypeFolder}/${safePubFolder}/${safeFolderName} (${year})`;

      const series = await prisma.series.upsert({
          where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: cvId.toString() } },
          update: { 
              monitored: true, 
              coverUrl: image, 
              name, 
              cvId: parseInt(cvId), 
              matchState: 'MATCHED',
              year: parseInt(year) 
          },
          create: { 
              cvId: parseInt(cvId), 
              metadataId: cvId.toString(), 
              metadataSource: 'COMICVINE',
              matchState: 'MATCHED',
              name, 
              year: parseInt(year) || new Date().getFullYear(), 
              publisher: safePublisher, 
              folderPath, 
              monitored: true,
              isManga: isManga,
              libraryId: targetLib?.id,
              coverUrl: image,
              description
          }
      });

      syncSeriesMetadata(cvId.toString(), series.folderPath, 'COMICVINE').catch(err => {
          Logger.log(`[Request] Background metadata sync failed: ${err.message}`, 'error');
      });

      Logger.log(`[Monitoring] ${name} is now actively being monitored.`, 'success');

      if (initialStatus === 'PENDING_APPROVAL') {
          // --- CHANGED: Unified Notifier Call ---
          SystemNotifier.sendAlert('pending_request', {
              title: name,
              imageUrl: image,
              user: token.name as string,
              description: description,
              publisher: safePublisher,
              year: year,
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
        const isReleased = isReleasedYet(issue.store_date, issue.cover_date);
        
        let issueImage = issue.image?.medium_url || issue.image?.small_url || image;
        
        if (!isReleased && (!issueImage || issueImage.includes('placeholder') || issueImage.includes('default'))) {
            const fallback = await getMetronCover(name, issue.issue_number, metronUserSetting?.value, metronPassSetting?.value);
            if (fallback) issueImage = fallback;
        }

        let issueStatus = initialStatus;
        if (!isReleased) issueStatus = 'UNRELEASED';

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

      return NextResponse.json({ 
        success: true, 
        message: initialStatus === 'PENDING' ? `Queued ${createdRequests.length} issues.` : "Sent for Admin approval." 
      });

    } else {
      const searchName = type === 'issue' && body.issueNumber 
        ? `${name} #${body.issueNumber}` 
        : name;

      if (body.issueNumber && (!image || image.includes('placeholder') || image.includes('default'))) {
         const fallback = await getMetronCover(name, body.issueNumber, metronUserSetting?.value, metronPassSetting?.value);
         if (fallback) image = fallback;
      }

      const newReq = await prisma.request.create({
        data: {
          userId: userId,
          volumeId: cvId.toString(),
          status: initialStatus,
          activeDownloadName: searchName,
          imageUrl: image,
          downloadLink: skipIndexers && initialStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null
        }
      });

      if (initialStatus === 'PENDING_APPROVAL') {
          // --- CHANGED: Unified Notifier Call ---
          SystemNotifier.sendAlert('pending_request', {
              title: searchName,
              imageUrl: image,
              user: token.name as string,
              description: description,
              publisher: safePublisher,
              year: year,
              date: new Date().toLocaleString()
          }).catch(() => {});
      }

      if (initialStatus === 'PENDING') {
        searchAndDownload(newReq.id, searchName, year, safePublisher, isManga, skipIndexers).catch(e => Logger.log(getErrorMessage(e), 'error'));
      }

      evaluateTrophies(userId).catch(() => {});

      return NextResponse.json({ 
        success: true, 
        message: initialStatus === 'PENDING' ? "Download started." : "Pending Admin approval.",
        requestId: newReq.id,
        status: initialStatus
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
      data: { status, notified: false }
    });

    await AuditLogger.log('UPDATED_REQUEST_STATUS', { requestId: id, newStatus: status, title: reqRecord.activeDownloadName }, userId);
    
    if (status === 'PENDING') {
      let year = "";
      let publisher = "";
      let description = "";
      let seriesNameForBatch = reqRecord.volumeId;
      
      if (reqRecord.volumeId && reqRecord.volumeId !== "0") {
         const series = await prisma.series.findFirst({ where: { metadataId: reqRecord.volumeId, metadataSource: 'COMICVINE' } });
         if (series) {
             year = series.year.toString();
             publisher = series.publisher || "Unknown";
             description = series.description || "";
             seriesNameForBatch = series.name;
         }
      }
      
      const searchName = reqRecord.activeDownloadName || "";
      Logger.log(`[Request] Admin approved request: ${searchName}`, 'info');

      let shouldNotifyApproval = true;
      let approvalTitle = searchName || reqRecord.volumeId || "Unknown Comic";
      let approvalDesc = description;

      if (reqRecord.volumeId && reqRecord.volumeId !== "0") {
          const stillPendingApproval = await prisma.request.count({
              where: {
                  userId: reqRecord.userId,
                  volumeId: reqRecord.volumeId,
                  status: 'PENDING_APPROVAL'
              }
          });

          if (stillPendingApproval > 0) {
              shouldNotifyApproval = false;
          } else {
              const twoHoursBefore = new Date(reqRecord.createdAt.getTime() - 2 * 60 * 60 * 1000);
              const twoHoursAfter = new Date(reqRecord.createdAt.getTime() + 2 * 60 * 60 * 1000);

              const batchApprovedCount = await prisma.request.count({
                  where: {
                      userId: reqRecord.userId,
                      volumeId: reqRecord.volumeId,
                      status: { not: 'PENDING_APPROVAL' }, 
                      createdAt: { gte: twoHoursBefore, lte: twoHoursAfter }
                  }
              });

              if (batchApprovedCount > 1) {
                  approvalTitle = `${seriesNameForBatch} - ${batchApprovedCount} Issues Approved`;
                  approvalDesc = `An admin has approved your request for ${batchApprovedCount} issues of ${seriesNameForBatch}. They will begin downloading shortly.\n\n${description}`;
              }
          }
      }

      if (shouldNotifyApproval) {
          // --- CHANGED: Unified Notifier Call ---
          SystemNotifier.sendAlert('request_approved', {
              title: approvalTitle,
              imageUrl: reqRecord.imageUrl,
              user: token.name as string,
              requester: reqRecord.user?.username || "Unknown",
              email: reqRecord.user?.email,
              description: approvalDesc,
              publisher: publisher,
              year: year,
              date: new Date().toLocaleString()
          }).catch(() => {});
      }

      const isManga = await detectManga({ name: searchName, publisher: { name: publisher } });
      
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