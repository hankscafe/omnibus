import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // 1. FETCH HEATMAP DATA (Last 365 Days)
        const oneYearAgo = new Date();
        oneYearAgo.setDate(oneYearAgo.getDate() - 365);
        oneYearAgo.setHours(0, 0, 0, 0);

        const dailyStats = await prisma.dailyReadingStat.findMany({
            where: { userId, date: { gte: oneYearAgo } },
            orderBy: { date: 'asc' }
        });

        const heatmapMap: Record<string, number> = {};
        let totalPagesReadThisYear = 0;
        
        dailyStats.forEach(stat => {
            const dateStr = stat.date.toISOString().split('T')[0];
            heatmapMap[dateStr] = stat.pagesRead;
            totalPagesReadThisYear += stat.pagesRead;
        });

        // 2. FETCH WRAPPED DATA (Top Genres, Publishers, Characters)
        const allProgress = await prisma.readProgress.findMany({
            where: { userId },
            include: { issue: { include: { series: true } } }
        });

        const publisherCounts: Record<string, number> = {};
        const genreCounts: Record<string, number> = {};
        const characterCounts: Record<string, number> = {};

        allProgress.forEach(prog => {
            if (!prog.issue) return;
            
            // Publisher weighting
            const pub = prog.issue.series?.publisher;
            if (pub && pub !== "Unknown") {
                publisherCounts[pub] = (publisherCounts[pub] || 0) + 1;
            }

            // Genre weighting (Stored as JSON array strings in Issue)
            try {
                if ((prog.issue as any).genres) {
                    const genres = JSON.parse((prog.issue as any).genres);
                    if (Array.isArray(genres)) {
                        genres.forEach(g => {
                            if (g !== "NONE") genreCounts[g] = (genreCounts[g] || 0) + 1;
                        });
                    }
                }
            } catch (e) {}

            // Character weighting
            try {
                if (prog.issue.characters) {
                    const characters = JSON.parse(prog.issue.characters);
                    if (Array.isArray(characters)) {
                        characters.forEach(c => {
                            if (c !== "NONE") characterCounts[c] = (characterCounts[c] || 0) + 1;
                        });
                    }
                }
            } catch (e) {}
        });

        const getTop = (obj: Record<string, number>) => {
            const sorted = Object.entries(obj).sort((a, b) => b[1] - a[1]);
            return sorted.length > 0 ? sorted[0][0] : "None";
        };

        return NextResponse.json({
            heatmap: heatmapMap,
            totalPagesReadThisYear,
            topPublisher: getTop(publisherCounts),
            topGenre: getTop(genreCounts),
            topCharacter: getTop(characterCounts)
        });

    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}