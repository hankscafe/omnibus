import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import fs from 'fs';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    // Check if the frontend is specifically asking for a lean, active-only payload
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('activeOnly') === 'true';

    const whereClause = activeOnly ? {
        status: { 
            in: ['PENDING', 'PENDING_APPROVAL', 'MANUAL_DDL', 'DOWNLOADING', 'STALLED', 'FAILED', 'ERROR'] 
        }
    } : {};

    const requests = await prisma.request.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: { user: true }
    });

    const volumeIds = requests.map(r => parseInt(r.volumeId));
    const seriesList = await prisma.series.findMany({ where: { cvId: { in: volumeIds } } });

    const formattedRequests = requests.map(req => {
      const series = seriesList.find(s => s.cvId === parseInt(req.volumeId));

      let seriesDisplayName = "";
      let issueNumberStr = "";
      
      if (req.activeDownloadName) {
          const match = req.activeDownloadName.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
          if (match && match[1]) {
              issueNumberStr = ` Issue #${match[1].padStart(3, '0')}`;
          } else {
              const fallback = req.activeDownloadName.replace(/\b(19|20)\d{2}\b/g, '').match(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/);
              if (fallback && fallback[1]) issueNumberStr = ` Issue #${fallback[1].padStart(3, '0')}`;
          }
      }

      if (series) {
          seriesDisplayName = `${series.name}${issueNumberStr} (${series.year})`;
      } else {
          seriesDisplayName = req.activeDownloadName || `Unknown Series (${req.volumeId})`;
      }

      return {
        id: req.id,
        userId: req.userId,
        volumeId: req.volumeId,
        seriesName: seriesDisplayName, 
        baseSeriesName: series?.name || "", 
        userName: req.user ? req.user.username : 'System',
        createdAt: req.createdAt,
        updatedAt: req.updatedAt,
        status: req.status,
        progress: req.progress, 
        downloadLink: req.downloadLink,
        imageUrl: req.imageUrl,
        activeDownloadName: req.activeDownloadName,
        retryCount: req.retryCount || 0 
      };
    });

    return NextResponse.json(formattedRequests);
  } catch (error: unknown) {
    return NextResponse.json([]); 
  }
}

export async function DELETE(request: Request) {
  try {
    let idsToDelete: string[] = [];
    const { searchParams } = new URL(request.url);
    const urlId = searchParams.get('id');
    
    if (urlId) idsToDelete.push(urlId);
    else {
        try {
            const body = await request.json();
            if (body.ids && Array.isArray(body.ids)) idsToDelete = body.ids;
            else if (body.id) idsToDelete.push(body.id);
        } catch (e) {}
    }

    if (idsToDelete.length === 0) {
      return NextResponse.json({ error: "Missing Request IDs" }, { status: 400 });
    }

    const cleanupGhostSeries = async (ids: string[]) => {
        for (const id of ids) {
            try {
                const req = await prisma.request.findUnique({ where: { id } });
                if (req && req.volumeId) {
                    const series = await prisma.series.findFirst({ where: { cvId: parseInt(req.volumeId) } });
                    if (series && series.folderPath && fs.existsSync(series.folderPath)) {
                        const files = await fs.promises.readdir(series.folderPath);
                        const hasFiles = files.some(f => f.toLowerCase().endsWith('.cbz') || f.toLowerCase().endsWith('.cbr'));
                        if (!hasFiles) await prisma.series.delete({ where: { id: series.id } }).catch(() => {});
                    }
                }
            } catch(e) {}
        }
    };
    
    cleanupGhostSeries(idsToDelete); 

    await prisma.request.deleteMany({ where: { id: { in: idsToDelete } } });
    
    return NextResponse.json({ success: true, count: idsToDelete.length }, { status: 200 });

  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}