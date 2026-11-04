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
import { authenticateKomga, komgaGuard, komgaError, noContent } from '@/lib/komga/auth';
import { bookLabel, findAccessibleIssue } from '@/lib/komga/data';
import { komgaPageNumber, readProgressIndex } from '@/lib/komga/dto';
import { pagesReadSince } from '@/lib/koreader-progress';

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
            return komgaError(400);
        }

        const { id } = await params;
        const found = await findAccessibleIssue(id, auth.libs);
        if (!found.ok) return komgaError(found.status);
        const issue = found.issue;
        const userId = auth.user.id;

        const existing = await prisma.readProgress.findUnique({ where: { userId_issueId: { userId, issueId: issue.id } } });
        const total = issue.pageCount || existing?.totalPages || 0;
        // Komga's page is 1-based; ReadProgress keeps the web reader's 0-based index (#262). Page 1
        // is index 0, which the "in progress" checks (`currentPage > 0`) read as not started yet.
        const requested = Number(body.page);
        const requestedPage = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
        const completed = body.completed === true || (total > 0 && requestedPage >= total);
        // Finished is stored as the page count, as the web reader and KOReader write it.
        const currentPage = completed && total > 0 ? total : readProgressIndex(requestedPage);
        const position = { currentPage, totalPages: total, isCompleted: completed };

        // The daily heatmap counts pages moved forward, never backward (the reader's rule).
        await recordDailyReading(userId, issue.id, pagesReadSince(existing, position));

        await prisma.readProgress.upsert({
            where: { userId_issueId: { userId, issueId: issue.id } },
            update: { currentPage, totalPages: total, isCompleted: completed, updatedAt: new Date() },
            create: { userId, issueId: issue.id, currentPage, totalPages: total, isCompleted: completed },
        });
        // One line per report, so a finished chapter that never syncs (On Deck stays empty) shows
        // up as a missing line rather than a mystery.
        Logger.log(
            completed
                ? `[Komga] ${auth.user.username} finished "${bookLabel(issue)}" (book ${issue.id})`
                : `[Komga] ${auth.user.username} is on page ${komgaPageNumber(position, total)} of "${bookLabel(issue)}" (book ${issue.id})`,
            'info',
        );

        evaluateTrophies(userId).catch((err: unknown) => {
            Logger.log(`[Komga read-progress] Trophy evaluation failed: ${getErrorMessage(err)}`, 'error');
        });

        return noContent();
    });
}
