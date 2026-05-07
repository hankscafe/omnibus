// src/app/api/recommendations/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

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
                        filePath: { not: null }, // <-- STRICT CHECK
                        OR: targetTags.map(tag => ({ 
                            genres: { 
                                contains: tag
                            } 
                        })) 
                    } 
                }
            },
            take: 7, 
            include: { 
                _count: { select: { issues: { where: { filePath: { not: null } } } } }, // <-- STRICT CHECK
                issues: { 
                    where: { coverUrl: { not: null }, filePath: { not: null } }, // <-- STRICT CHECK
                    select: { coverUrl: true }, 
                    take: 1 
                }
            }
        });

        const formatted = recommendations.map(s => {
            let coverUrl = (s as any).coverUrl || null;
            
            if (!coverUrl && s.issues && s.issues.length > 0 && s.issues[0].coverUrl) {
                coverUrl = s.issues[0].coverUrl;
            }

            if (coverUrl && !coverUrl.startsWith('/api/')) {
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

        return NextResponse.json({ series: formatted, basedOn: lastRead.issue.series.name });

    } catch (error: unknown) {
        Logger.log(`[Recommendations API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 });
    }
}