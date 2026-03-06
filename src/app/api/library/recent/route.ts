export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        // Fetch the 7 most recently added series that contain at least 1 issue
        const recentSeries = await prisma.series.findMany({
            where: {
                issues: { some: {} } // Ensures we don't show empty/ghost folders
            },
            orderBy: { id: 'desc' }, // Orders chronologically by newest added
            take: 7,
            include: {
                _count: {
                    select: { issues: true }
                }
            }
        });

        const formatted = recentSeries.map(s => {
            let coverUrl = (s as any).coverUrl || null;
            if (!coverUrl && s.folderPath) {
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
    } catch (error: any) {
        console.error("Recent Library API Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}