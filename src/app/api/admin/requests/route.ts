// src/app/api/admin/requests/route.ts

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('activeOnly') === 'true';

    const whereClause = activeOnly ? {
        status: { in: ['PENDING', 'PENDING_APPROVAL', 'MANUAL_DDL', 'DOWNLOADING', 'STALLED', 'FAILED', 'ERROR'] }
    } : {};

    const requests = await prisma.request.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: { 
          user: { select: { username: true } }
      }
    });

    const volumeIds = Array.from(new Set(requests.map(r => r.volumeId)));
    const seriesList = await prisma.series.findMany({ 
        where: { metadataId: { in: volumeIds }, metadataSource: 'COMICVINE' } 
    });

    const formattedRequests = requests.map(req => {
      const series = seriesList.find(s => s.metadataId === req.volumeId);
      let issueNumberStr = "";
      if (req.activeDownloadName) {
          const match = req.activeDownloadName.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
          if (match) issueNumberStr = ` Issue #${match[1].padStart(3, '0')}`;
      }

      return {
        id: req.id,
        userId: req.userId, // <-- FIXED: Added missing userId back into the payload
        seriesName: series ? `${series.name}${issueNumberStr} (${series.year})` : (req.activeDownloadName || `Volume ${req.volumeId}`), 
        userName: req.user?.username || 'System',
        createdAt: req.createdAt,
        updatedAt: req.updatedAt,
        status: req.status,
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
                const series = await prisma.series.findFirst({ where: { metadataId: req.volumeId, metadataSource: 'COMICVINE' } });
                if (series?.folderPath && fs.existsSync(series.folderPath)) {
                    const files = await fs.promises.readdir(series.folderPath);
                    const hasFiles = files.some(f => f.toLowerCase().match(/\.(cbz|cbr)$/));
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
    return NextResponse.json({ error: "Delete Failed" }, { status: 500 });
  }
}