import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import path from 'path';
import fs from 'fs';

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

    const items = await Promise.all(history.map(async (p) => {
        const folderPath = p.issue.series.folderPath;
        let seriesCoverUrl = null;
        try {
            if (fs.existsSync(folderPath)) {
                const files = await fs.promises.readdir(folderPath);
                const coverFile = files.find(f => ['cover.jpg', 'cover.png', 'folder.jpg'].includes(f.toLowerCase()));
                if (coverFile) seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, coverFile))}`;
            }
        } catch (e) {}

        return {
            id: p.id,
            seriesName: p.issue.series.name || path.basename(folderPath),
            issueNumber: p.issue.number,
            filePath: p.issue.filePath,
            seriesPath: folderPath,
            percentage: Math.round((p.currentPage / p.totalPages) * 100),
            isCompleted: p.isCompleted,
            updatedAt: p.updatedAt,
            seriesCvId: p.issue.series.cvId,
            seriesCoverUrl
        };
    }));

    return NextResponse.json({ items });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}