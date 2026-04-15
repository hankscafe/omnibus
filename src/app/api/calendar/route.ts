// src/app/api/calendar/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Get today's date formatted as YYYY-MM-DD for accurate string comparison
        const today = new Date().toISOString().split('T')[0];

        const upcoming = await prisma.issue.findMany({
            where: {
                releaseDate: { gte: today }
            },
            include: {
                series: {
                    select: { name: true, folderPath: true, coverUrl: true, publisher: true }
                }
            },
            orderBy: { releaseDate: 'asc' },
            take: 200 // Prevent massive payloads
        });

        const formatted = upcoming.map((issue: any) => {
            const rawCover = issue.coverUrl || issue.series.coverUrl;
            let safeCover = rawCover;
            
            // If the cover exists, but it is NOT a web URL or an absolute web path, route it through the local file proxy
            if (rawCover && !rawCover.startsWith('http') && !rawCover.startsWith('/')) {
                safeCover = `/api/library/cover?path=${encodeURIComponent(rawCover)}`;
            }

            return {
                id: issue.id,
                seriesId: issue.seriesId,
                seriesName: issue.series.name,
                issueNumber: issue.number,
                issueName: issue.name,
                publisher: issue.series.publisher,
                releaseDate: issue.releaseDate,
                coverUrl: safeCover,
                seriesPath: issue.series.folderPath
            };
        });

        return NextResponse.json(formatted);
    } catch (error) {
        Logger.log(`Calendar API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to fetch calendar data." }, { status: 500 });
    }
}