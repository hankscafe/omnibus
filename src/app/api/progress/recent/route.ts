import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';

export async function GET(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    
    let userId = (session?.user as any)?.id || null;
    
    if (!userId && session?.user) {
        const sessionEmail = session.user.email;
        const sessionName = session.user.name;
        
        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    ...(sessionEmail ? [{ email: sessionEmail }] : []),
                    ...(sessionName ? [{ username: sessionName }] : [])
                ]
            }
        });
        userId = user?.id || null;
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 1. Fetch only the data we need from the DB
    const recentProgress = await prisma.readProgress.findMany({
        where: {
            userId: userId,
            isCompleted: false,
            totalPages: { gt: 0 }
        },
        include: {
            issue: { include: { series: true } }
        },
        orderBy: { updatedAt: 'desc' },
        take: 7
    });

    // 2. BLAZING FAST MAPPING (No more physical disk scans!)
    const items = recentProgress.map(p => {
        const percentage = Math.round((p.currentPage / p.totalPages) * 100);
        const folderPath = p.issue.series.folderPath;
        
        // Use DB cover URL instantly, fallback to deferred folder path
        let seriesCoverUrl = (p.issue.series as any).coverUrl || null;
        if (!seriesCoverUrl && folderPath) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(folderPath)}`;
        }

        const fileName = path.basename(p.issue.filePath || '');
        const explicitMatch = fileName.match(/(?:#|issue\s*#?)\s*(\d+(\.\d+)?)/i);
        
        let parsedNum = p.issue.number;
        if (explicitMatch) parsedNum = explicitMatch[1];
        
        return {
            id: p.id,
            seriesName: p.issue.series.name || path.basename(folderPath).replace(/\s\(\d{4}\)$/, ""),
            issueNumber: parsedNum,
            filePath: p.issue.filePath,
            seriesPath: folderPath,
            currentPage: p.currentPage,
            totalPages: p.totalPages,
            percentage: percentage,
            seriesCvId: p.issue.series.cvId,
            seriesCoverUrl: seriesCoverUrl
        };
    });

    return NextResponse.json({ items });

  } catch (error: any) {
    console.error("Recent Progress API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}