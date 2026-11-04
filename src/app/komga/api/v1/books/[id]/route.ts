// src/app/komga/api/v1/books/[id]/route.ts — #206 Komga facade: one book. Panels (#262) asks for
// it each time it opens a book from the Komga-shaped OPDS catalog, and before it reports progress.
// The same BookDto as the series' book list, with its place in the series and the caller's page.
import { authenticateKomga, komgaGuard, komgaJson, komgaError } from '@/lib/komga/auth';
import { bookDtos, findAccessibleIssue, loadOrderedBooks } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('books/{id}', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleIssue(id, auth.libs);
        if (!found.ok) return komgaError(found.status);
        const series = found.issue.series;
        if (!series) return komgaError(404);

        const book = (await loadOrderedBooks(series.id)).filter((o) => o.issue.id === found.issue.id);
        if (book.length === 0) return komgaError(404); // no file: not a book the facade lists
        const [dto] = await bookDtos(book, series, auth.user.id);
        return komgaJson(dto);
    });
}
