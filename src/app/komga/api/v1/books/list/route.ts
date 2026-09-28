// src/app/komga/api/v1/books/list/route.ts — #206 Komga facade, for Paperback's 0.9 "Komga"
// source: POST /api/v1/books/list is how it lists a series' chapters (`?unpaged=true` + a body
// pinning seriesId, deleted=false, mediaStatus=READY). Read-only; the key is checked before the
// body is read, and the caller's library grants apply outside whatever the body asks.
import { authenticateKomga, komgaGuard, komgaJson, komgaError } from '@/lib/komga/auth';
import { searchBooks } from '@/lib/komga/data';
import { parsePaging } from '@/lib/komga/query';
import { readSearchBody, SearchError } from '@/lib/komga/search';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    return komgaGuard('books/list', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        let body;
        try {
            body = await readSearchBody(req);
        } catch (e) {
            if (e instanceof SearchError) return komgaError(e.status);
            throw e;
        }
        if (body.ignored.length) Logger.log(`[Komga books/list] Ignored unsupported search terms: ${body.ignored.join(', ')}`, 'debug');
        const paging = parsePaging(new URL(req.url).searchParams);
        return komgaJson(await searchBooks({ libs: auth.libs, userId: auth.user.id, body, paging }));
    });
}

export async function GET(req: Request) {
    return komgaError(405, new URL(req.url).pathname.replace(/^\/komga/, ''));
}
