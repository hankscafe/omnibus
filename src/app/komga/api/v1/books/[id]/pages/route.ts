// src/app/komga/api/v1/books/[id]/pages/route.ts — #206 Komga facade: the page list of a book.
// Paperback builds `${komgaAPI}/books/{id}/pages/{number}` from these (1-based), so the count
// must be real: a scan that persisted pageCount 0 is healed from the archive here, as the OPDS
// feed does for its pse:count.
import { authenticateKomga, komgaGuard, komgaJson, komgaText } from '@/lib/komga/auth';
import { findAccessibleIssue, healedPageCount } from '@/lib/komga/data';
import { toPageDtos } from '@/lib/komga/dto';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('books/{id}/pages', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleIssue(id, auth.libs);
        if (!found.ok) return komgaText(found.status, found.status === 404 ? 'Not Found' : 'Forbidden');
        return komgaJson(toPageDtos(await healedPageCount(found.issue)));
    });
}
