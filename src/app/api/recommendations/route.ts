import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ series: [], basedOn: null });

    try {
        const lastRead = await prisma.readProgress.findFirst({
            where: { userId },
            orderBy: { updatedAt: 'desc' },
            include: { issue: { include: { series: true } } }
        });

        if (!lastRead || !lastRead.issue) return NextResponse.json({ series: [], basedOn: null });

        let targetTags: string[] = [];
        try {
            const genres = JSON.parse((lastRead.issue as any).genres || "[]");
            if (Array.isArray(genres)) targetTags = [...targetTags, ...genres];
        } catch (e) {}

        if (targetTags.length === 0) return NextResponse.json({ series: [], basedOn: null });

        const recommendations = await prisma.series.findMany({
            where: {
                id: { not: lastRead.issue.seriesId },
                issues: { 
                    some: { 
                        OR: targetTags.map(tag => ({ 
                            genres: { 
                                contains: tag // Removed mode: 'insensitive'
                            } 
                        })) 
                    } 
                }
            },
            take: 7, 
            include: { issues: { select: { id: true } } }
        });

        const formatted = recommendations.map(s => {
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
                issueCount: s.issues.length
            };
        });

        return NextResponse.json({ series: formatted, basedOn: lastRead.issue.series.name });

    } catch (error) {
        return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 });
    }
}