export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET() {
    try {
        const recentSeries = await prisma.series.findMany({
            where: { issues: { some: {} } },
            orderBy: { id: 'desc' },
            take: 7,
            include: { _count: { select: { issues: true } } }
        });

        const formatted = recentSeries.map(s => {
            // --- FIX: Proxy external URL if it hasn't been downloaded locally yet ---
            let coverUrl = (s as any).coverUrl || null;
            if (coverUrl && coverUrl.startsWith('http')) {
                coverUrl = `/api/library/cover?path=${encodeURIComponent(coverUrl)}`;
            } else if (!coverUrl && s.folderPath) {
                coverUrl = `/api/library/cover?path=${encodeURIComponent(s.folderPath)}`;
            }

            return {
                id: s.id,
                name: s.name,
                year: s.year,
                path: s.folderPath,
                coverUrl: coverUrl,
                issueCount: s._count.issues
            };
        });

        return NextResponse.json({ items: formatted });
    } catch (error: unknown) {
        Logger.log(`Recent Library API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}