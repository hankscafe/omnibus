// src/app/komga/api/v1/books/[id]/pages/[n]/route.ts — #206 Komga facade: one page image.
// Komga numbers pages from 1; the OPDS-PSE streamer indexes from 0 and already does everything
// else (key validation, library grants, engine offload with local fallback, RAR/7z via the engine,
// immutable caching) — so page n is handed to it in-process as index n-1, headers and all.
// `?convert=png` (sent for non-image page types) is accepted and ignored: pages come back as WebP.
import { GET as streamOpdsPage } from '@/app/api/opds/page/[issueId]/[pageIndex]/route';
import { komgaGuard, komgaText } from '@/lib/komga/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
    return komgaGuard('books/{id}/pages/{n}', async () => {
        const { id, n } = await params;
        const page = /^\d+$/.test(n) ? parseInt(n, 10) : NaN;
        if (!Number.isInteger(page) || page < 1) return komgaText(404, 'Page Not Found');
        return streamOpdsPage(
            new Request(req.url, { headers: req.headers }),
            { params: Promise.resolve({ issueId: id, pageIndex: String(page - 1) }) },
        );
    });
}
