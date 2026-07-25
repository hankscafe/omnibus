// src/app/api/recommendations/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getAccessibleLibraryIds, seriesAccessWhere } from '@/lib/library-access';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ series: [], basedOn: null });

    // Per-library access: only recommend series from libraries the user has been granted.
    const accessibleLibs = await getAccessibleLibraryIds(userId, (session?.user as any)?.role);

    try {
        // Seed rotation: collapse the last reads to DISTINCT series and pick by day bucket, so the
        // shelf rotates daily across everything recently read instead of pinning to the single
        // most-recent ReadProgress row (which only changes when the user starts a new series).
        const recentReads = await prisma.readProgress.findMany({
            where: { userId },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            include: { issue: { include: { series: true } } }
        });

        const seeds: typeof recentReads = [];
        const seenSeries = new Set<string>();
        for (const rp of recentReads) {
            const sid = rp.issue?.seriesId;
            if (!sid || seenSeries.has(sid)) continue;
            seenSeries.add(sid);
            seeds.push(rp);
        }
        if (seeds.length === 0) return NextResponse.json({ series: [], basedOn: null });

        const parseTags = (raw: string | null | undefined): string[] => {
            try {
                const arr = JSON.parse(raw || "[]");
                return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string' && t.length > 0) : [];
            } catch { return []; }
        };

        // Walk the rotation from today's bucket until a seed with usable genres is found —
        // Issue.genres first, Series.genres as fallback (a genre-less seed used to blank the shelf).
        const dayBucket = Math.floor(Date.now() / 86_400_000);
        let seedRead: (typeof recentReads)[number] | null = null;
        let targetTags: string[] = [];
        for (let i = 0; i < seeds.length; i++) {
            const cand = seeds[(dayBucket + i) % seeds.length];
            const tags = parseTags((cand.issue as any).genres);
            const withFallback = tags.length > 0 ? tags : parseTags((cand.issue?.series as any)?.genres);
            if (withFallback.length > 0) {
                seedRead = cand;
                targetTags = withFallback;
                break;
            }
        }
        if (!seedRead || !seedRead.issue) return NextResponse.json({ series: [], basedOn: null });

        const candidates = await prisma.series.findMany({
            where: {
                id: { not: seedRead.issue.seriesId },
                ...seriesAccessWhere(accessibleLibs),
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
            take: 21,
            include: {
                _count: { select: { issues: { where: { filePath: { not: null } } } } }, // <-- STRICT CHECK
                issues: {
                    where: { coverUrl: { not: null }, filePath: { not: null } }, // <-- STRICT CHECK
                    select: { coverUrl: true },
                    take: 1
                }
            }
        });

        // Day-seeded shuffle: the 7 cards vary day to day but stay stable within a day
        // (SQLite has no ORDER BY random() through Prisma, and per-request thrash would look broken).
        let shuffleState = dayBucket >>> 0;
        const nextRand = () => {
            shuffleState = (shuffleState + 0x6D2B79F5) >>> 0;
            let t = shuffleState;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(nextRand() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        const recommendations = candidates.slice(0, 7);

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

        return NextResponse.json({ series: formatted, basedOn: seedRead.issue.series.name });

    } catch (error: unknown) {
        Logger.log(`[Recommendations API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to generate recommendations" }, { status: 500 });
    }
}