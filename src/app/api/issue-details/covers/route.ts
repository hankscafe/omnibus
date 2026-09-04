// src/app/api/issue-details/covers/route.ts
//
// Cover thumbnails for a SET of provider issue ids, in one call.
//
// The Smart Matcher's bulk mapping binds many files to one volume at once, and an admin verifying
// those bindings wants to see the covers (field report by robotshavehearts2, who was opening
// ComicVine in another tab to check). Asking /api/issue-details per row would cost one provider
// call per file — 30 files, 30 calls against a ~200/hour ComicVine key, just for thumbnails. This
// route asks ComicVine for up to 100 issues per request with a two-field field_list instead.
//
// Metron needs nothing here: its issue_list already carries each cover, so the volume payload
// hands them over with the mapping (see ../route.ts).
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';

const CHUNK = 100;
const MAX_IDS = 300;

export async function POST(request: Request) {
    const token = await getToken({ req: request as any });
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const body = await request.json().catch(() => ({}));
        const provider = String(body?.provider || 'COMICVINE').toUpperCase();
        const rawIds: unknown = body?.ids;
        if (!Array.isArray(rawIds)) return NextResponse.json({ error: 'Missing ids' }, { status: 400 });

        // Numeric ids only: they are interpolated into ComicVine's filter expression, and a cap
        // keeps one request from turning into a dozen upstream pages.
        const ids = Array.from(new Set(rawIds.map(String).map(s => s.trim()).filter(s => /^\d+$/.test(s)))).slice(0, MAX_IDS);
        if (ids.length === 0) return NextResponse.json({ covers: {} });

        // Metron's covers arrive with the volume's issue list, so there is nothing to fetch.
        if (provider === 'METRON') return NextResponse.json({ covers: {} });

        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        const cvKey = setting?.value;
        if (!cvKey || cvKey === '********') return NextResponse.json({ covers: {} });

        const covers: Record<string, string> = {};
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            try {
                const res = await cachedCvGet('https://comicvine.gamespot.com/api/issues/', {
                    params: {
                        api_key: cvKey, format: 'json',
                        filter: `id:${chunk.join('|')}`,
                        field_list: 'id,image',
                        limit: CHUNK,
                    },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 15000,
                });
                for (const item of res.data?.results || []) {
                    const url = item?.image?.thumb_url || item?.image?.small_url || item?.image?.medium_url;
                    if (item?.id != null && url) covers[String(item.id)] = url;
                }
            } catch (e) {
                // A thumbnail is a convenience: a failed chunk degrades to no cover for those rows,
                // never an error the admin has to clear before matching.
                Logger.log(`[Issue Covers] ComicVine lookup failed for a chunk of ${chunk.length}: ${getErrorMessage(e)}`, 'warn');
            }
        }

        return NextResponse.json({ covers });
    } catch (error: unknown) {
        Logger.log(`[Issue Covers] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
