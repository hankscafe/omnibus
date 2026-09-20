// src/lib/komga/cover.ts
//
// #206: thumbnails for the Komga facade. Paperback loads `${komgaAPI}/series/{id}/thumbnail` and
// `${komgaAPI}/books/{id}/thumbnail` as bare URLs through its Basic-auth interceptor. The image
// itself is served by the existing cover route (local cover files, remote provider art, first-page
// renders, disk-cached WebP thumbnails) — but that route sits under /api/library, which the
// middleware 401s for a client with no session cookie, so a redirect is not an option. The facade
// calls the cover handler in-process instead.
import { NextRequest } from 'next/server';
import { GET as serveCover } from '@/app/api/library/cover/route';

/** Paperback tiles and the series hero are small; 640px is the largest cached width. */
const THUMB_WIDTH = '640';

export type CoverQuery = { path: string } | { issueId: string };

/**
 * A stored coverUrl → the cover route's query. Local covers are stored as the route's own URL
 * (`/api/library/cover?path=…&v=…`), provider art as an absolute URL the route proxies; anything
 * else (null, legacy shapes) yields null so the caller can pick its fallback.
 */
export function coverQueryFor(coverUrl: string | null | undefined): CoverQuery | null {
    if (!coverUrl) return null;
    if (coverUrl.startsWith('/api/library/cover?')) {
        const p = new URL(coverUrl, 'http://omnibus.local').searchParams.get('path');
        return p ? { path: p } : null;
    }
    if (/^https?:\/\//i.test(coverUrl)) return { path: coverUrl };
    return null;
}

export function delegateCover(req: Request, query: CoverQuery): Promise<Response> {
    const url = new URL('/api/library/cover', req.url);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set('w', THUMB_WIDTH);
    return serveCover(new NextRequest(url, { headers: req.headers }));
}
