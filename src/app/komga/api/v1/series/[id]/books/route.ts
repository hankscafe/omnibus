// src/app/komga/api/v1/series/[id]/books/route.ts — #206 Komga facade: a series' books = its
// issues with files, in the series page's default order (the run by number, then the annuals),
// each with the caller's read progress. Paperback asks for this unpaged
// (`?unpaged=true&media_status=READY&deleted=false`) and builds its chapter list from it.
import { authenticateKomga, komgaGuard, komgaJson, komgaText } from '@/lib/komga/auth';
import { bookDtos, findAccessibleSeries, loadOrderedBooks } from '@/lib/komga/data';
import { komgaPage } from '@/lib/komga/dto';
import { parsePaging } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('series/{id}/books', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleSeries(id, auth.libs);
        if (!found.ok) return komgaText(found.status, found.status === 404 ? 'Not Found' : 'Forbidden');

        const ordered = await loadOrderedBooks(found.series.id);
        const { page, size, unpaged } = parsePaging(new URL(req.url).searchParams, 500);
        const slice = unpaged ? ordered : ordered.slice(page * size, page * size + size);
        const content = await bookDtos(slice, found.series, auth.user.id);
        return komgaJson(unpaged
            ? komgaPage(content, 0, Math.max(1, content.length), ordered.length)
            : komgaPage(content, page, size, ordered.length));
    });
}
