// src/app/komga/api/v1/series/list/route.ts — #206 Komga facade, for Paperback's 0.9 "Komga"
// source: POST /api/v1/series/list is its search (`?page&size=40&sort=titleSort` + a body with
// fullTextSearch and genre/tag/library/collection conditions) and its Continue Reading section
// (`sort=readProgress.readDate,desc` + readStatus IN_PROGRESS). Read-only; the key is checked
// before the body is read, and the caller's library grants apply outside whatever the body asks.
import { authenticateKomga, komgaGuard, komgaJson, komgaError } from '@/lib/komga/auth';
import { searchSeries } from '@/lib/komga/data';
import { parsePaging, parseSeriesSort } from '@/lib/komga/query';
import { readSearchBody, SearchError } from '@/lib/komga/search';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    return komgaGuard('series/list', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        let body;
        try {
            body = await readSearchBody(req);
        } catch (e) {
            if (e instanceof SearchError) return komgaError(e.status);
            throw e;
        }
        if (body.ignored.length) Logger.log(`[Komga series/list] Ignored unsupported search terms: ${body.ignored.join(', ')}`, 'debug');
        const sp = new URL(req.url).searchParams;
        const { page, size } = parsePaging(sp);
        return komgaJson(await searchSeries({ libs: auth.libs, userId: auth.user.id, body, sort: parseSeriesSort(sp), page, size }));
    });
}

export async function GET(req: Request) {
    return komgaError(405, new URL(req.url).pathname.replace(/^\/komga/, ''));
}
