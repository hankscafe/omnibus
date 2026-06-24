// src/app/api/request/route.ts
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import axios from 'axios';
import path from 'path';
import { SystemNotifier } from '@/lib/notifications';
import { evaluateTrophies } from '@/lib/trophy-evaluator'; 
import { detectManga } from '@/lib/manga-detector'; 
import { isReleasedYet } from '@/lib/utils';
import { searchAndDownload, processAutomationQueue } from '@/lib/automation';
import { getErrorMessage } from '@/lib/utils/error';
import { syncSeriesMetadata } from '@/lib/metadata-fetcher'; 
import { AuditLogger } from '@/lib/audit-logger';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { getMetronCover } from '@/lib/metadata/providers/metron-cover';

export const dynamic = 'force-dynamic';

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
        where: { metadataId: { in: volumeIds } } 
    });

    const metronUserSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
    const metronPassSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });

    const formattedRequests = await Promise.all(requests.map(async req => {
      const series = seriesList.find(s => 
        s.metadataId === req.volumeId && 
        s.metadataSource === (req.metadataSource || 'COMICVINE')
      );
      let issueNumberStr = "";
      
      // Added -? to capture the negative sign
      const regexMatch = req.activeDownloadName?.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)/i);
      if (regexMatch) {
          let parsedNum = regexMatch[1];
          const isNeg = parsedNum.startsWith('-');
          if (isNeg) parsedNum = parsedNum.substring(1);
          
          issueNumberStr = ` Issue #${isNeg ? '-' : ''}${parsedNum.padStart(3, '0')}`;
      }

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
        metadataSource: req.metadataSource || 'COMICVINE', 
        seriesPath: series?.folderPath || null,
        seriesName: req.activeDownloadName || (series ? `${series.name}${issueNumberStr} (${series.year})` : `Volume ${req.volumeId}`), 
        activeDownloadName: req.activeDownloadName,
        userName: token.name || 'User',
        createdAt: req.createdAt,
        updatedAt: req.updatedAt,
        status: req.status,
        progress: req.progress, 
        downloadLink: req.downloadLink,
        indexer: (req as any).indexer,
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
    const { cvId, type, monitored, directSource, metadataSource = 'COMICVINE', monitorOnly, releaseDate } = body; 
    let { image, publisher, year, description } = body;

    let resolvedCvId = cvId;

    if (resolvedCvId === undefined || resolvedCvId === null || resolvedCvId === 0 || resolvedCvId === '0') {
        if (type === 'volume') {
            Logger.log(`[Request] Missing Series ID for ${name}. Attempting to resolve dynamically...`, 'info');
            try {
                if (metadataSource === 'METRON') {
                    const metron = new MetronProvider();
                    const results = await metron.searchSeries(name);
                    if (results.length > 0) {
                        resolvedCvId = parseInt(results[0].sourceId);
                    }
                } else {
                    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    if (cvKeySetting?.value) {
                        const cvRes = await axios.get(`https://comicvine.gamespot.com/api/search/`, {
                            params: { api_key: cvKeySetting.value, format: 'json', query: name, resources: 'volume', limit: 1 },
                            headers: { 'User-Agent': 'Omnibus/1.0' },
                            timeout: 5000
                        });
                        if (cvRes.data?.results?.length > 0) {
                            resolvedCvId = cvRes.data.results[0].id;
                        }
                    }
                }
            } catch (e) {
                Logger.log(`[Request] Dynamic ID resolution failed: ${(e as any).message}`, 'warn');
            }

            if (!resolvedCvId || resolvedCvId === 0 || resolvedCvId === '0') {
                return NextResponse.json({ error: 'Missing Metadata ID. The provider did not supply a valid series ID, and automated lookup failed.' }, { status: 400 });
            }
        } else {
            resolvedCvId = 0;
        }
    }

    if (!name || name === "Unknown" || type === 'volume' || !publisher || publisher === "Unknown" || !year) {
        if (metadataSource === 'METRON') {
            try {
                const metron = new MetronProvider();
                let details;
                try {
                    details = await metron.getSeriesDetails(resolvedCvId.toString());
                } catch(e) {
                    details = await metron.getSeriesByCvId(resolvedCvId.toString());
                    if (details) resolvedCvId = parseInt(details.sourceId);
                }
                
                if (details) {
                    if (type === 'volume' || !name || name === "Unknown") name = details.name;
                    if (!publisher || publisher === "Unknown") publisher = details.publisher;
                    if (!year) year = details.year.toString();
                    if (!description) description = details.description;
                }
            } catch (e) {}
        } else {
            try {
                const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                if (cvKeySetting?.value) {
                    const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${resolvedCvId}/`, {
                        params: { api_key: cvKeySetting.value, format: 'json', field_list: 'publisher,description,deck,name,start_year' },
                        headers: { 'User-Agent': 'Omnibus/1.0' },
                        timeout: 4000
                    });
                    const volData = cvVolRes.data?.results;
                    if (volData) {
                        if (type === 'volume' || !name || name === "Unknown") name = volData.name;
                        if (!publisher || publisher === "Unknown") publisher = volData.publisher?.name;
                        if (!year) year = volData.start_year;
                        if (!description) description = volData.description || volData.deck;
                    }
                }
            } catch (e) {}
        }
    }

    if (!name || name === "Unknown") {
        return NextResponse.json({ error: 'Series name unresolved. Please try Interactive Search.' }, { status: 400 });
    }

    const skipIndexers = directSource === 'getcomics';
    // Gate: only users granted the Request permission (or admins) may create requests. Fresh DB lookup
    // so a revoked/granted permission takes effect immediately rather than waiting for a new JWT.
    const requester = await prisma.user.findUnique({
      where: { id: (token.id || token.sub) as string },
      select: { role: true, canRequest: true, autoApproveRequests: true },
    });
    const requesterIsAdmin = requester?.role === 'ADMIN';
    if (!requesterIsAdmin && !requester?.canRequest) {
      return NextResponse.json({ error: "You don't have permission to make requests. Ask an admin to grant you the Request permission." }, { status: 403 });
    }
    const initialStatus = (requesterIsAdmin || requester?.autoApproveRequests) ? 'PENDING' : 'PENDING_APPROVAL';

    const safePublisher = publisher || "Unknown";
    const isManga = await detectManga({ name, publisher: { name: safePublisher }, year: parseInt(year) });
    const libraryTypeFolder = isManga ? 'Manga' : 'Comics';

    if (type === 'volume') {
      Logger.log(`[Request] User ${token.name} requested full Volume via ${metadataSource}: ${name}`, 'info');
      
      const libraries = await prisma.library.findMany();
      let targetLib = isManga 
          ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
          : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga);
      if (!targetLib) targetLib = libraries[0];

      const safeFolderName = name.replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
      const safePubFolder = safePublisher !== "Unknown" ? safePublisher.replace(/[<>:"/\\|?*]/g, '').trim() : "Other";

      const settings = await prisma.systemSetting.findMany();
      const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
      const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";

      const relFolderPath = folderPattern
          .replace(/{Publisher}/gi, safePubFolder)
          .replace(/{Series}/gi, safeFolderName)
          .replace(/{Year}/gi, year ? year.toString() : "")
          .replace(/{VolumeYear}/gi, year ? year.toString() : "")
          .replace(/\(\s*\)/g, '') 
          .replace(/\[\s*\]/g, '') 
          .replace(/\s+/g, ' ')
          .trim();

      const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
      const basePath = targetLib ? targetLib.path : `/${libraryTypeFolder}`;
      
      const folderPath = path.join(basePath, ...folderParts).replace(/\\/g, '/');

      const series = await prisma.series.upsert({
          where: { metadataSource_metadataId: { metadataSource: metadataSource, metadataId: resolvedCvId.toString() } },
          update: { 
              monitored: true, 
              coverUrl: image, 
              name, 
              cvId: metadataSource === 'COMICVINE' ? parseInt(resolvedCvId.toString()) : null, 
              matchState: 'MATCHED',
              year: parseInt(year) 
          },
          create: { 
              cvId: metadataSource === 'COMICVINE' ? parseInt(resolvedCvId.toString()) : null, 
              metadataId: resolvedCvId.toString(), 
              metadataSource: metadataSource,
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

      syncSeriesMetadata(resolvedCvId.toString(), series.folderPath, metadataSource).catch(err => {});

      if (monitorOnly) {
          return NextResponse.json({ 
              success: true, 
              message: "Subscribed! Omnibus will automatically download future issues." 
          });
      }

      if (initialStatus === 'PENDING_APPROVAL') {
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

      const createdRequests = [];

      const existingLibraryIssues = await prisma.issue.findMany({
          where: { seriesId: series.id, filePath: { not: null } },
          select: { number: true }
      });

      const ownedIssueNumbers = new Set(existingLibraryIssues.map(i => {
           const match = i.number.match(/(-?\d+(?:\.\d+)?)/);
           return match ? parseFloat(match[1]) : NaN;
       }).filter(n => !isNaN(n)));

      if (metadataSource === 'METRON') {
          const metron = new MetronProvider();
          const issues = await metron.getSeriesIssues(resolvedCvId.toString());
          
          for (const issue of issues) {
              const parsedIssueNum = parseFloat(issue.issueNumber || (issue as any).issue || "");
              if (!isNaN(parsedIssueNum) && ownedIssueNumbers.has(parsedIssueNum)) continue; 

              const issueYear = issue.releaseDate ? issue.releaseDate.split('-')[0] : year;
              let searchName = `${name} #${issue.issueNumber}`;
              if (issue.name && issue.name !== name && !issue.name.includes(`#${issue.issueNumber}`)) {
                  searchName += `: ${issue.name}`;
              } else if (issue.name && issue.name.includes(`#${issue.issueNumber}`)) {
                  searchName = issue.name;
              }
              const isReleased = isReleasedYet(issue.releaseDate, issue.releaseDate);
              
              const issueImage = issue.coverUrl || image;
              
              let issueStatus = initialStatus;
              if (!isReleased) issueStatus = 'UNRELEASED';

              const existing = await prisma.request.findFirst({
                  where: { volumeId: resolvedCvId.toString(), activeDownloadName: searchName }
              });

              if (!existing) {
                  const newReq = await prisma.request.create({
                      data: {
                          userId: userId,
                          volumeId: resolvedCvId.toString(),
                          metadataSource: metadataSource,
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
      } else {
          const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
          const cvApiKey = cvKeySetting?.value;
          if (!cvApiKey) throw new Error("Missing ComicVine API Key");

          const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
            params: {
              api_key: cvApiKey, format: 'json', filter: `volume:${resolvedCvId}`,
              field_list: 'id,name,issue_number,cover_date,store_date,image' 
            },
            headers: { 'User-Agent': 'Omnibus/1.0' }
          });

          const issues = cvRes.data.results || [];

          for (const issue of issues) {
            const parsedIssueNum = parseFloat(issue.issue_number);
            if (!isNaN(parsedIssueNum) && ownedIssueNumbers.has(parsedIssueNum)) continue; 

            const issueYear = (issue.store_date || issue.cover_date || year || "").split('-')[0];
            let searchName = `${name} #${issue.issue_number}`;
            if (issue.name && issue.name !== name && !issue.name.includes(`#${issue.issue_number}`)) {
                searchName += `: ${issue.name}`;
            } else if (issue.name && issue.name.includes(`#${issue.issue_number}`)) {
                searchName = issue.name;
            }
            const isReleased = isReleasedYet(issue.store_date, issue.cover_date);
            
            let issueImage = issue.image?.medium_url || issue.image?.small_url || image;
            
            if (!isReleased && (!issueImage || issueImage.includes('placeholder') || issueImage.includes('default'))) {
                const fallback = await getMetronCover(name, issue.issue_number, metronUserSetting?.value, metronPassSetting?.value);
                if (fallback) issueImage = fallback;
            }

            let issueStatus = initialStatus;
            if (!isReleased) issueStatus = 'UNRELEASED';

            const existing = await prisma.request.findFirst({
              where: { volumeId: resolvedCvId.toString(), activeDownloadName: searchName }
            });

            if (!existing) {
              const newReq = await prisma.request.create({
                data: {
                  userId: userId, volumeId: resolvedCvId.toString(), metadataSource: metadataSource,
                  status: issueStatus, activeDownloadName: searchName, imageUrl: issueImage,
                  downloadLink: skipIndexers && issueStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null 
                }
              });
              if (issueStatus === 'PENDING') {
                createdRequests.push({ id: newReq.id, name: searchName, year: issueYear, publisher: safePublisher, isManga, skipIndexers });
              }
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
      const searchName = type === 'issue' && body.issueNumber && !name.includes(`#${body.issueNumber}`)
        ? `${name} #${body.issueNumber}` : name;

      if (body.issueNumber && (!image || image.includes('placeholder') || image.includes('default'))) {
         const fallback = await getMetronCover(name, body.issueNumber, metronUserSetting?.value, metronPassSetting?.value);
         if (fallback) image = fallback;
      }

      let issueStatus = initialStatus;
      if (releaseDate && !isReleasedYet(releaseDate, releaseDate)) issueStatus = 'UNRELEASED';

      const newReq = await prisma.request.create({
        data: {
          userId: userId, volumeId: resolvedCvId.toString(), metadataSource: metadataSource,
          status: issueStatus, activeDownloadName: searchName, imageUrl: image,
          downloadLink: skipIndexers && issueStatus === 'PENDING_APPROVAL' ? 'DIRECT_GETCOMICS' : null
        }
      });

      if (issueStatus === 'PENDING_APPROVAL') {
          SystemNotifier.sendAlert('pending_request', {
              title: searchName, imageUrl: image, user: token.name as string,
              description: description, publisher: safePublisher, year: year, date: new Date().toLocaleString()
          }).catch(() => {});
      }

      if (issueStatus === 'PENDING') {
        searchAndDownload(newReq.id, searchName, year, safePublisher, isManga, skipIndexers).catch(e => Logger.log(getErrorMessage(e), 'error'));
      }

      evaluateTrophies(userId).catch(() => {});

      return NextResponse.json({ 
        success: true, 
        message: issueStatus === 'PENDING' ? "Download started." : (issueStatus === 'UNRELEASED' ? "Subscribed for release." : "Pending Admin approval."),
        requestId: newReq.id,
        status: issueStatus
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
      data: { 
          status, 
          notified: false,
          // --- NEW: Reset blocklist and retries if pushing back to the automated queue ---
          ...(status === 'PENDING' ? { failedLinks: "[]", retryCount: 0 } : {})
      }
    });

    await AuditLogger.log('UPDATED_REQUEST_STATUS', { requestId: id, newStatus: status, title: reqRecord.activeDownloadName }, userId);
    
    // --- NEW: SKELETON CLEANUP FOR ADMIN DENIALS ---
    if (status === 'CANCELLED') {
        if (reqRecord.volumeId && reqRecord.volumeId !== "0") {
            const series = await prisma.series.findFirst({ 
                where: { metadataId: reqRecord.volumeId, metadataSource: reqRecord.metadataSource || 'COMICVINE' } 
            });
            if (series) {
                const downloadedIssuesCount = await prisma.issue.count({
                    where: { seriesId: series.id, filePath: { not: null } }
                });
                const otherActiveReqs = await prisma.request.count({
                    where: { 
                        volumeId: reqRecord.volumeId, 
                        id: { not: id },
                        status: { notIn: ['CANCELLED', 'FAILED', 'ERROR', 'STALLED'] } 
                    }
                });
                if (downloadedIssuesCount === 0 && otherActiveReqs === 0) {
                    await prisma.issue.deleteMany({ where: { seriesId: series.id } });
                    await prisma.series.delete({ where: { id: series.id } });
                }
            }
        }
    }
    
    if (status === 'PENDING') {
      let year = "";
      let publisher = "";
      let description = "";
      let seriesNameForBatch = reqRecord.volumeId;
      
      if (reqRecord.volumeId && reqRecord.volumeId !== "0") {
         const series = await prisma.series.findFirst({ where: { metadataId: reqRecord.volumeId } });
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

// Inside src/app/api/request/route.ts
export async function DELETE(request: NextRequest) {
  const token = await getToken({ req: request });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (token.id || token.sub) as string;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    const reqRecord = await prisma.request.findUnique({ where: { id } });
    if (!reqRecord || reqRecord.userId !== userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // --- NEW: ABORT ACTIVE DOWNLOAD CLIENT JOBS ---
    // If the download was handed off to qBittorrent/SABnzbd/etc., hunt it down and delete it
    if (reqRecord.status === 'DOWNLOADING' && reqRecord.downloadLink && !reqRecord.downloadLink.startsWith('http')) {
        try {
            const { DownloadService } = await import('@/lib/download-clients');
            const activeDownloads = await DownloadService.getAllActiveDownloads();
            
            // Match via Hash (or fallback to Name)
            const activeJob = activeDownloads.find((d: any) => 
                d.id.toLowerCase() === reqRecord.downloadLink?.toLowerCase() || 
                d.name === reqRecord.activeDownloadName
            );
            
            if (activeJob) {
                const clientConfig = await prisma.downloadClient.findFirst({
                    where: { name: activeJob.clientName }
                });
                
                if (clientConfig) {
                    await DownloadService.removeDownload(clientConfig, activeJob.id);
                    Logger.log(`[Request API] Terminated active download and wiped files from ${clientConfig.name} for cancelled request ${id}`, 'info');
                }
            }
        } catch (e) {
            Logger.log(`[Request API] Non-fatal error attempting to cancel active external download: ${e}`, 'warn');
        }
    }

    // 1. CHANGE STATUS TO CANCELLED
    await prisma.request.update({
      where: { id },
      data: { status: 'CANCELLED', notified: false }
    });

    // 2. KILL PENDING BACKGROUND JOBS IN BULLMQ
    try {
        const { omnibusQueue } = await import('@/lib/queue');
        const existingJobs = await omnibusQueue.getJobs(['waiting', 'delayed', 'active', 'paused']);
        for (const job of existingJobs) {
            if (job.id === `SEARCH_${id}` || job.data?.requestId === id) {
                // job.remove() works on waiting jobs. Active jobs will be caught by the status check in automation.ts
                await job.remove().catch(() => {});
                Logger.log(`[Request API] Removed pending background job for cancelled request ${id}`, 'info');
            }
        }
    } catch (e) {
        Logger.log(`[Request API] Error removing job for ${id}: ${e}`, 'warn');
    }

    // 3. SAFE DB-DRIVEN SERIES CLEANUP
    if (reqRecord.volumeId && reqRecord.volumeId !== "0") {
        const series = await prisma.series.findFirst({ 
            where: { metadataId: reqRecord.volumeId, metadataSource: reqRecord.metadataSource || 'COMICVINE' } 
        });
        
        if (series) {
            // Check the database to see if we actually own any files for this series
            const downloadedIssuesCount = await prisma.issue.count({
                where: { seriesId: series.id, filePath: { not: null } }
            });

            // Ensure no other active requests exist for this specific volume before we delete it
            const otherActiveReqs = await prisma.request.count({
                where: { 
                    volumeId: reqRecord.volumeId, 
                    id: { not: id },
                    status: { notIn: ['CANCELLED', 'FAILED', 'ERROR', 'STALLED'] } 
                }
            });

            if (downloadedIssuesCount === 0 && otherActiveReqs === 0) {
                await prisma.issue.deleteMany({ where: { seriesId: series.id } });
                await prisma.series.delete({ where: { id: series.id } });
                Logger.log(`[Request API] Cleaned up empty series placeholder for cancelled volume ${reqRecord.volumeId}`, 'info');
            }
        }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log(`[Request API] Cancel Error: ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}