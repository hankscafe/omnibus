// src/app/api/progress/recent/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import type { RecentProgressPayload } from '@/types/api/shelves';

export async function GET(_request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    
    let userId = session?.user?.id || null;
    
    if (!userId && session?.user) {
        const sessionEmail = session.user.email;
        const sessionName = session.user.name;
        
        const user = await prisma.user.findFirst({
            where: { OR: [ ...(sessionEmail ? [{ email: sessionEmail }] : []), ...(sessionName ? [{ username: sessionName }] : []) ] }
        });
        userId = user?.id || null;
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only issues that still have a file: Continue Reading opens it. Until beta.045 progress on an issue whose
    // file was gone (the row's filePath cleared) was listed too, and its card opened the reader on path=null.
    // Asked of the database, so the seven cards are all readable; the filter below only narrows the type.
    const recentProgress = await prisma.readProgress.findMany({
        where: { userId: userId, isCompleted: false, totalPages: { gt: 0 }, issue: { filePath: { not: null }, NOT: { filePath: '' } } },
        include: { issue: { include: { series: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 7
    });
    const readable = recentProgress.flatMap(p => (p.issue.filePath ? [{ ...p, filePath: p.issue.filePath }] : []));

    const items = readable.map(p => {
        const percentage = Math.round((p.currentPage / p.totalPages) * 100);
        const folderPath = p.issue.series.folderPath;
        
        let seriesCoverUrl = (p.issue.series as any).coverUrl || null;
        
        if (!seriesCoverUrl && p.issue.coverUrl) {
            seriesCoverUrl = p.issue.coverUrl;
        }

        if (seriesCoverUrl && !seriesCoverUrl.startsWith('/api/')) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(seriesCoverUrl)}`;
        } else if (!seriesCoverUrl && folderPath) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(folderPath)}`;
        }

        const fileName = path.basename(p.filePath);
        const explicitMatch = fileName.match(/(?:#|issue\s*#?)\s*(-?\d+(\.\d+)?)/i);
        
        let parsedNum = p.issue.number;
        if (explicitMatch) parsedNum = explicitMatch[1];
        
        return {
            id: p.id,
            seriesName: p.issue.series.name || path.basename(folderPath).replace(/\s\(\d{4}\)$/, ""),
            issueNumber: parsedNum,
            filePath: p.filePath,
            seriesPath: folderPath,
            currentPage: p.currentPage,
            totalPages: p.totalPages,
            percentage: percentage,
            metadataId: p.issue.series.metadataId || null,
            metadataSource: p.issue.series.metadataSource || 'COMICVINE',
            seriesCoverUrl: seriesCoverUrl
        };
    });

    return NextResponse.json({ items } satisfies RecentProgressPayload);

  } catch (error: unknown) {
    Logger.log(`Recent Progress API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}