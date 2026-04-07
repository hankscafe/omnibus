import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('activeOnly') === 'true';

    const whereClause = activeOnly ? {
        status: { in: ['PENDING', 'PENDING_APPROVAL', 'MANUAL_DDL', 'DOWNLOADING', 'STALLED', 'FAILED', 'ERROR'] }
    } : {};

    // HIGH FIX: Use include to pre-fetch related user and series to eliminate N+1 queries
    const requests = await prisma.request.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: { 
          user: { select: { username: true } }
      }
    });

    // Efficiently batch look up series for all request volume IDs
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

    // HIGH FIX: Changed to awaited async function to prevent race conditions
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
    
    // Ensure cleanup completes before the request record is deleted
    await cleanupGhostSeries(idsToDelete).catch(err => Logger.log(`[Requests API] Cleanup failed: ${err.message}`, 'warn'));
    await prisma.request.deleteMany({ where: { id: { in: idsToDelete } } });
    
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: "Delete Failed" }, { status: 500 });
  }
}