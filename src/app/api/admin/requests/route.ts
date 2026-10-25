// src/app/api/admin/requests/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';
import { COMIC_EXT_REGEX } from '@/lib/utils/formats';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { markRequestsCompleted } from '@/lib/request-fulfilment';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('activeOnly') === 'true';

    const whereClause = activeOnly ? {
        status: { in: ['PENDING', 'PENDING_APPROVAL', 'MANUAL_DDL', 'DOWNLOADING', 'STALLED', 'FAILED', 'ERROR', 'NEEDS_REVIEW'] }
    } : {};

    const requests = await prisma.request.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: { 
          user: { select: { username: true } }
      }
    });

    const volumeIds = Array.from(new Set(requests.map(r => r.volumeId)));
    // Select only the fields used below (not the multi-KB description etc.), and index by
    // (metadataSource, metadataId) so the per-request lookup is O(1) instead of O(requests × series).
    const seriesList = await prisma.series.findMany({
        where: { metadataId: { in: volumeIds } },
        select: { metadataId: true, metadataSource: true, name: true, year: true, folderPath: true }
    });
    const seriesMap = new Map(seriesList.map(s => [`${s.metadataSource}:${s.metadataId}`, s]));

    const formattedRequests = requests.map(req => {
      const series = seriesMap.get(`${req.metadataSource || 'COMICVINE'}:${req.volumeId}`);
      let issueNumberStr = "";
      if (req.activeDownloadName) {
          const match = req.activeDownloadName.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
          if (match) issueNumberStr = ` Issue #${match[1].padStart(3, '0')}`;
      }

      return {
        id: req.id,
        userId: req.userId,
        volumeId: req.volumeId,
        metadataSource: req.metadataSource || 'COMICVINE',
        seriesName: req.activeDownloadName || (series ? `${series.name}${issueNumberStr} (${series.year})` : `Volume ${req.volumeId}`), 
        activeDownloadName: req.activeDownloadName,
        seriesPath: series?.folderPath || null,
        userName: req.user?.username || 'System',
        createdAt: req.createdAt,
        updatedAt: req.updatedAt,
        status: req.status,
        // WHY it is in that state (beta.008): admins only - My Requests' route doesn't pass it on.
        statusNote: req.statusNote ?? null,
        progress: req.progress,
        downloadLink: req.downloadLink,
        imageUrl: req.imageUrl && req.imageUrl.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(req.imageUrl)}` : req.imageUrl,
        retryCount: req.retryCount || 0 
      };
    });

    return NextResponse.json(formattedRequests);
  } catch (error: unknown) {
    Logger.log(`[Requests API] Fetch Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Fetch Failed" }, { status: 500 }); 
  }
}

// The search worker never checks a request's status, so a closed request's queued search would still
// run - and download the issue. One already running can't be removed (it is locked).
async function dropQueuedSearches(closed: { id: string; activeDownloadName: string | null }[]): Promise<void> {
  try {
    const { omnibusQueue } = await import('@/lib/queue');
    await Promise.all(closed.map(r =>
      omnibusQueue.getJob(`SEARCH_${r.id}`)
        .then(job => job?.remove())
        .catch(e => Logger.log(`[Requests API] Couldn't take the queued search of "${r.activeDownloadName || r.id}" off the queue: ${getErrorMessage(e)}`, 'warn'))
    ));
  } catch (e) {
    Logger.log(`[Requests API] Couldn't reach the queue to drop completed requests' searches: ${getErrorMessage(e)}`, 'warn');
  }
}

// Request Management's "Mark completed" (beta.010): an admin closes requests the Smart Matcher and the
// Series Monitor can't tie to a series. Which ones close, and how, is request-fulfilment.ts.
export async function PATCH(request: Request) {
  try {
    const session = await getServerSession(await getAuthOptions());
    const admin = session?.user as { id?: string; name?: string | null; role?: string } | undefined;
    if (admin?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (body?.action !== 'complete' || ids.length === 0) {
      return NextResponse.json({ error: 'Name the requests to mark completed.' }, { status: 400 });
    }
    const notify = body.notify !== false;

    const { completed, skipped } = await markRequestsCompleted(ids, { notify, by: admin.name || 'an admin' });

    if (completed.length > 0) {
      try {
        await AuditLogger.log('COMPLETE_REQUEST', {
          requestIds: completed.map(r => r.id),
          titles: completed.map(r => r.activeDownloadName || r.id),
          notify,
        }, admin.id || 'System');
      } catch (e) {
        Logger.log(`[Requests API] Couldn't write the audit entry for Mark completed: ${getErrorMessage(e)}`, 'warn');
      }
      // Not awaited: the requests are closed, and with Redis down BullMQ retries its commands for
      // minutes - nothing after the write may hold up the answer (the #198 settings-save lesson).
      void dropQueuedSearches(completed);
    }

    return NextResponse.json({ success: true, completed: completed.length, skipped });
  } catch (error: unknown) {
    Logger.log(`[Requests API] Mark completed failed: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Mark completed failed' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = session?.user ? (session.user as any).id : 'System';

    let idsToDelete: string[] = [];
    const { searchParams } = new URL(request.url);
    const urlId = searchParams.get('id');
    
    if (urlId) idsToDelete.push(urlId);
    else {
        const body = await request.json();
        if (body.ids) idsToDelete = body.ids;
        else if (body.id) idsToDelete.push(body.id);
    }

    if (idsToDelete.length === 0) return NextResponse.json({ error: "Missing IDs" }, { status: 400 });

    const requestsToDelete = await prisma.request.findMany({
        where: { id: { in: idsToDelete } }
    });

    const cleanupGhostSeries = async (ids: string[]) => {
        for (const id of ids) {
            const req = await prisma.request.findUnique({ where: { id } });
            if (req && req.volumeId !== "0") {
                // --- FIX: Respect the exact metadata source of the request to clean up ghost Metron series ---
                const series = await prisma.series.findFirst({ 
                    where: { 
                        metadataId: req.volumeId, 
                        metadataSource: req.metadataSource || 'COMICVINE' 
                    } 
                });
                
                if (series?.folderPath && fs.existsSync(series.folderPath)) {
                    const files = await fs.promises.readdir(series.folderPath);
                    const hasFiles = files.some(f => COMIC_EXT_REGEX.test(f));
                    if (!hasFiles) await prisma.series.delete({ where: { id: series.id } });
                }
            }
        }
    };
    
    await cleanupGhostSeries(idsToDelete).catch(err => Logger.log(`[Requests API] Cleanup failed: ${err.message}`, 'warn'));
    await prisma.request.deleteMany({ where: { id: { in: idsToDelete } } });
    
    await AuditLogger.log('DELETE_REQUEST', { 
        requestIds: idsToDelete,
        titles: requestsToDelete.map(r => r.activeDownloadName || r.volumeId)
    }, userId);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`[Requests API] Delete Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Delete Failed" }, { status: 500 });
  }
}