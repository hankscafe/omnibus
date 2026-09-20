// src/app/komga/api/v1/books/[id]/thumbnail/route.ts — #206 Komga facade: a book's cover. The
// issue's own cover when it has one (provider art or a cached local file), else its archive's
// first page rendered by the cover route (the discussion #182 local-first path).
import { authenticateKomga, komgaGuard, komgaText } from '@/lib/komga/auth';
import { coverQueryFor, delegateCover } from '@/lib/komga/cover';
import { findAccessibleIssue } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('books/{id}/thumbnail', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleIssue(id, auth.libs);
        if (!found.ok) return komgaText(found.status, found.status === 404 ? 'Not Found' : 'Forbidden');
        return delegateCover(req, coverQueryFor(found.issue.coverUrl) ?? { issueId: found.issue.id });
    });
}
