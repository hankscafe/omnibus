// src/app/komga/api/v1/books/[id]/read-progress/route.ts — #206 Komga facade: read progress
// write-back. Paperback only syncs "finished" (`{ page: 1, completed: true }` when a chapter is
// marked read); Komga's contract also allows a bare `{ page }`. Both land in ReadProgress exactly
// as the web reader's page turns do — same daily-reading ledger, same trophy evaluation — so an
// issue finished on the phone counts on the profile like one finished in the browser.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { recordDailyReading } from '@/lib/reading-stats';
import { evaluateTrophies } from '@/lib/trophy-evaluator';
import { authenticateKomga, komgaGuard, komgaText, noContent } from '@/lib/komga/auth';
import { findAccessibleIssue } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

interface ReadProgressUpdate {
    page?: unknown;
    completed?: unknown;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('books/{id}/read-progress', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;

        let body: ReadProgressUpdate;
        try {
            body = (await req.json()) as ReadProgressUpdate;
            if (!body || typeof body !== 'object') throw new Error('not an object');
        } catch {
            return komgaText(400, 'Bad Request');
        }

        const { id } = await params;
        const found = await findAccessibleIssue(id, auth.libs);
        if (!found.ok) return komgaText(found.status, found.status === 404 ? 'Not Found' : 'Forbidden');
        const issue = found.issue;
        const userId = auth.user.id;

        const existing = await prisma.readProgress.findUnique({ where: { userId_issueId: { userId, issueId: issue.id } } });
        const total = issue.pageCount || existing?.totalPages || 0;
        const requested = Number(body.page);
        const requestedPage = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
        const completed = body.completed === true || (total > 0 && requestedPage >= total);
        const currentPage = completed ? Math.max(total, requestedPage) : requestedPage;

        // The daily heatmap counts pages moved forward, never backward (the reader's rule).
        const delta = existing ? Math.max(0, currentPage - existing.currentPage) : currentPage;
        await recordDailyReading(userId, issue.id, delta);

        await prisma.readProgress.upsert({
            where: { userId_issueId: { userId, issueId: issue.id } },
            update: { currentPage, totalPages: total, isCompleted: completed, updatedAt: new Date() },
            create: { userId, issueId: issue.id, currentPage, totalPages: total, isCompleted: completed },
        });

        evaluateTrophies(userId).catch((err: unknown) => {
            Logger.log(`[Komga read-progress] Trophy evaluation failed: ${getErrorMessage(err)}`, 'error');
        });

        return noContent();
    });
}
