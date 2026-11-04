// src/app/komga/opds/v1.2/books/[id]/file/[filename]/route.ts — #262: Komga's acquisition link.
// Panels ties a downloaded book to its Komga book through this link, and only then keeps (and
// reports) its reading progress. The filename is a label; the id decides which file is sent. The
// OPDS download does the rest in-process — key, download permission, library grants, Range.
import { GET as downloadOpdsIssue } from '@/app/api/opds/download/route';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string; filename: string }> }) {
    const { id } = await params;
    const download = new URL('/api/opds/download', req.url);
    download.searchParams.set('issueId', id);
    return downloadOpdsIssue(new Request(download, { headers: req.headers }));
}
