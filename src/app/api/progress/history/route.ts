// src/app/api/progress/history/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    let userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 1. Fetch only the necessary progress and relation data
    const history = await prisma.readProgress.findMany({
        where: { userId: userId },
        include: { issue: { include: { series: true } } },
        orderBy: { updatedAt: 'desc' }
    });

    // 2. BLAZING FAST MAPPING (Removed synchronous/async physical disk I/O!)
    const items = history.map((p) => {
        const folderPath = p.issue.series.folderPath;
        
        // Use DB cover URL instantly, fallback to the dynamic cover route
        let seriesCoverUrl = (p.issue.series as any).coverUrl || null;
        if (!seriesCoverUrl && folderPath) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(folderPath)}`;
        }

        // Safely extract the file name if a path exists
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
            seriesCvId: p.issue.series.cvId,
            seriesCoverUrl
        };
    });

    return NextResponse.json({ items });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}