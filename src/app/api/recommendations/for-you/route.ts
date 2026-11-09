// src/app/api/recommendations/for-you/route.ts
//
// Library-aware recommendations (Beta B; field report by robotshavehearts2): series the library
// does NOT have, ranked by the engine's FOR_YOU_SYNC from the SeriesCredit ledger and cached in
// the discover_cache_for_you SystemSetting. This route only READS the cache — a page load never
// spends a provider call — and applies what can go stale between rebuilds: volumes the library
// has since acquired or requested drop out, and the caller's own dismissals are hidden.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Not exported: a Next route module may only export handlers (the engine writes this key —
// recommendations.rs CACHE_KEY — and the two names must stay identical).
const FOR_YOU_CACHE_KEY = 'discover_cache_for_you';

interface ForYouItem {
    volumeId: string;
    name: string;
    startYear: number | null;
    publisher: string;
    image: string | null;
    countOfIssues: number;
    description: string | null;
    siteUrl: string | null;
    score: number;
    because: { kind: 'PERSON' | 'CHARACTER'; id: string; name: string }[];
    metadataSource: string;
}

export async function GET(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id as string | undefined;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { searchParams } = new URL(request.url);
        const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0);
        const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50));

        const cache = await prisma.systemSetting.findUnique({ where: { key: FOR_YOU_CACHE_KEY } });
        if (!cache?.value) return NextResponse.json({ builtAt: null, items: [], seeds: [], total: 0, nextOffset: null });

        let parsed: { builtAt?: string; seeds?: any[]; items?: ForYouItem[]; reason?: string };
        try { parsed = JSON.parse(cache.value); } catch { parsed = {}; }
        const all: ForYouItem[] = Array.isArray(parsed.items) ? parsed.items : [];
        const ids = all.map(i => String(i.volumeId));

        // Stale-between-rebuilds exclusions: acquired / attached / requested since, and this user's
        // "not interested". The rebuild already excludes the first three; this keeps the shelf honest
        // for the hours between runs (a Monitor click on one card must not leave it on the shelf).
        const [owned, attached, requested, dismissed] = ids.length === 0 ? [[], [], [], []] : await Promise.all([
            prisma.series.findMany({ where: { metadataSource: 'COMICVINE', metadataId: { in: ids } }, select: { metadataId: true } }),
            prisma.attachedVolume.findMany({ where: { metadataSource: 'COMICVINE', volumeId: { in: ids } }, select: { volumeId: true } }),
            prisma.request.findMany({ where: { volumeId: { in: ids } }, select: { volumeId: true }, distinct: ['volumeId'] }),
            prisma.recommendationDismissal.findMany({ where: { userId, source: 'COMICVINE', volumeId: { in: ids } }, select: { volumeId: true } }),
        ]);
        const gone = new Set<string>([
            ...owned.map(s => String(s.metadataId)),
            ...attached.map(a => a.volumeId),
            ...requested.map(r => r.volumeId),
            ...dismissed.map(d => d.volumeId),
        ]);

        const visible = all.filter(i => !gone.has(String(i.volumeId))).map(i => ({
            ...i,
            volumeId: String(i.volumeId),
            // Covers go through the same proxy the Discover feed uses (remote hosts stay off the page).
            image: i.image && i.image.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(i.image)}` : i.image,
        }));
        const slice = visible.slice(offset, offset + limit);
        const nextOffset = offset + limit < visible.length ? offset + limit : null;

        return NextResponse.json({
            builtAt: parsed.builtAt || null,
            reason: parsed.reason || null,
            seeds: Array.isArray(parsed.seeds) ? parsed.seeds : [],
            items: slice,
            total: visible.length,
            nextOffset,
        });
    } catch (error: unknown) {
        Logger.log(`[For You API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: 'Failed to load recommendations' }, { status: 500 });
    }
}
