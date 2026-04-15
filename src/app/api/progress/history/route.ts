export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function GET(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    let userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const history = await prisma.readProgress.findMany({
        where: { userId: userId },
        include: { issue: { include: { series: true } } },
        orderBy: { updatedAt: 'desc' }
    });

    const items = history.map((p) => {
        const folderPath = p.issue.series.folderPath;
        
        // --- FIX: Proxy external URL if it hasn't been downloaded locally yet ---
        let seriesCoverUrl = (p.issue.series as any).coverUrl || null;
        if (seriesCoverUrl && seriesCoverUrl.startsWith('http')) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(seriesCoverUrl)}`;
        } else if (!seriesCoverUrl && folderPath) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(folderPath)}`;
        }

        const safeSeriesName = p.issue.series.name || (folderPath ? path.basename(folderPath).replace(/\s\(\d{4}\)$/, "") : "Unknown Series");

        return {
            id: p.id,
            seriesName: safeSeriesName,
            issueNumber: p.issue.number,
            filePath: p.issue.filePath,
            seriesPath: folderPath,
            percentage: p.totalPages > 0 ? Math.round((p.currentPage / p.totalPages) * 100) : 0,
            isCompleted: p.isCompleted,
            updatedAt: p.updatedAt,
            seriesCvId: (p.issue.series.metadataSource === 'COMICVINE' && p.issue.series.metadataId) ? parseInt(p.issue.series.metadataId) : null,
            seriesCoverUrl
        };
    });

    return NextResponse.json({ items });
  } catch (error: unknown) {
    Logger.log(`[History API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}