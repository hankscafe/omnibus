// #240 (realAbitbol, PR B "notify on reality"): the reconciler that closes a request on what the
// watched-folder sweep actually imported. Mocked prisma + notifier, so each case is pinned to the
// exact transition it causes: COMPLETED with one "available" alert, NEEDS_REVIEW with one "needs
// review" alert, or nothing at all while the batch is still in flight.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    reconcileImportHandoffs,
    recordImportHandoff,
    recordPendingHandoff,
    dropPendingHandoff,
    rekeyPendingHandoff,
    watchedRelativePath,
    newImportBatchId,
    IMPORT_RECONCILE_GRACE_MS,
    IMPORTING_STALE_MS,
    IMPORT_REVIEW_RECHECK_WINDOW_MS,
    IMPORT_HANDOFF_RETENTION_MS,
} from '@/lib/import-handoff';

const mocks = vi.hoisted(() => ({
    requestFindMany: vi.fn(),
    requestUpdate: vi.fn(),
    handoffFindMany: vi.fn(),
    handoffCreate: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    handoffDeleteMany: vi.fn(async (_args: {
        where: { outcome: { not: string }; createdAt: { lt: Date } };
    }) => ({ count: 0 })),
    handoffUpdateMany: vi.fn(async (_args: { where: Record<string, unknown>; data: { relPath: string } }) => ({ count: 1 })),
    transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    sendAlert: vi.fn().mockResolvedValue(undefined),
    issueIsInLibrary: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findMany: mocks.requestFindMany, update: mocks.requestUpdate },
        importHandoff: {
            findMany: mocks.handoffFindMany,
            create: mocks.handoffCreate,
            deleteMany: mocks.handoffDeleteMany,
            updateMany: mocks.handoffUpdateMany,
        },
        $transaction: mocks.transaction,
    }
}));

vi.mock('@/lib/notifications', () => ({
    SystemNotifier: { sendAlert: mocks.sendAlert }
}));

// The library question itself is covered by request-dedupe.test.ts; here it is the reconciler's
// verdict that is under test.
vi.mock('@/lib/request-dedupe', () => ({
    issueNumberOf: (r: { issueNumber?: string | null }) => r.issueNumber ?? null,
    issueIsInLibrary: mocks.issueIsInLibrary,
}));

const importingRequest = (over: Record<string, unknown> = {}) => ({
    id: 'req_1',
    status: 'IMPORTING',
    volumeId: '101',
    metadataSource: 'COMICVINE',
    issueNumber: '37',
    activeDownloadName: 'X-Men #34-40 (2004)',
    imageUrl: null,
    updatedAt: new Date(),
    user: { username: 'nicolas', email: 'n@example.test' },
    ...over,
});

// A request the reconciler is re-checking: PR A settled it NEEDS_REVIEW, and the library decides
// whether that is still true.
const reviewedRequest = (over: Record<string, unknown> = {}) =>
    importingRequest({ status: 'NEEDS_REVIEW', ...over });

// The reconciler asks the request table twice (IMPORTING, then NEEDS_REVIEW), and once more per
// row-less request for the siblings on its link. The mock honours the query, so a row can never be
// answered by the population it is not in — and a re-check window that stops asking is visible.
const requestsAt = (rows: Record<string, unknown>[]) =>
    mocks.requestFindMany.mockImplementation(async (args: {
        where?: { status?: string; updatedAt?: { gte?: Date }; downloadLink?: string; id?: { not?: string } };
    }) => {
        const where = args?.where ?? {};
        return rows.filter(r => {
            if (where.status && r.status !== where.status) return false;
            if (where.downloadLink && r.downloadLink !== where.downloadLink) return false;
            if (where.id?.not && r.id === where.id.not) return false;
            if (where.updatedAt?.gte && new Date(r.updatedAt as Date).getTime() < where.updatedAt.gte.getTime()) return false;
            return true;
        });
    });

// Handoff rows, each tagged with the request ids its batch was written for. The mock answers both
// questions the reconciler asks — "my rows" (requestIds contains my id) and "the batch I joined"
// (requestIds contains a sibling's id) — from the same list, so a row is never invented by the test.
const handoffRows = (rows: Record<string, unknown>[]) =>
    mocks.handoffFindMany.mockImplementation(async (args: {
        where?: { requestIds?: { contains?: string }; OR?: { requestIds: { contains: string } }[] };
    }) => {
        const where = args?.where ?? {};
        const asked = where.requestIds?.contains
            ? [where.requestIds.contains.replace(/"/g, '')]
            : (where.OR ?? []).map(c => c.requestIds.contains.replace(/"/g, ''));
        return rows.filter(r => asked.some(id => (r.requestIds as string[] | undefined)?.includes(id)));
    });

describe('reconcileImportHandoffs', () => {
    beforeEach(() => {
        requestsAt([]);
        mocks.handoffFindMany.mockResolvedValue([]);
        mocks.issueIsInLibrary.mockResolvedValue(false);
    });

    it('does nothing while no request is waiting on an import', async () => {
        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 0, waiting: 0 });
        expect(mocks.handoffFindMany).not.toHaveBeenCalled();
        expect(mocks.sendAlert).not.toHaveBeenCalled();
    });

    it('waits while any file of the batch is still PENDING', async () => {
        requestsAt([importingRequest()]);
        mocks.handoffFindMany.mockResolvedValue([{ outcome: 'IMPORTED' }, { outcome: 'PENDING' }]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 0, waiting: 1 });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
        expect(mocks.sendAlert).not.toHaveBeenCalled();
    });

    it('closes COMPLETED with one "available" alert when the batch settled and the issue is in the library', async () => {
        requestsAt([importingRequest()]);
        mocks.handoffFindMany.mockResolvedValue([{ outcome: 'IMPORTED' }, { outcome: 'UNMATCHED' }]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });
        expect(mocks.issueIsInLibrary).toHaveBeenCalledWith({
            volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '37'
        });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_1' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
        expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            title: 'Issue #37 — X-Men #34-40 (2004)',
            user: 'nicolas',
            email: 'n@example.test'
        }));
    });

    it('closes NEEDS_REVIEW with one "needs review" alert when the batch settled without the issue', async () => {
        requestsAt([importingRequest()]);
        mocks.handoffFindMany.mockResolvedValue([{ outcome: 'UNMATCHED' }]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_1' },
            data: { status: 'NEEDS_REVIEW' }
        });
        expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
        expect(mocks.sendAlert).toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            title: 'X-Men #34-40 (2004)',
            description: expect.stringContaining('#37')
        }));
    });

    it('decides on the issue, not on the batch: an imported file whose issue never arrived is not "done"', async () => {
        requestsAt([importingRequest()]);
        mocks.handoffFindMany.mockResolvedValue([{ outcome: 'IMPORTED' }]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: 'req_1' }, data: { status: 'NEEDS_REVIEW' } });
    });

    it('waits out the grace period for a request that joined a batch and has no row of its own', async () => {
        requestsAt([importingRequest({ updatedAt: new Date() })]);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 0, waiting: 1 });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();

        // Past the grace, an IMPORTING row with nothing behind it is judged by the library instead of
        // being left IMPORTING forever (the health check flags it too).
        requestsAt([
            importingRequest({ updatedAt: new Date(Date.now() - IMPORT_RECONCILE_GRACE_MS - 60_000) })
        ]);
        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: 'req_1' }, data: { status: 'NEEDS_REVIEW' } });
        expect(mocks.sendAlert).toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            description: expect.stringContaining('never reported back')
        }));
    });

    it('closes a row-less request COMPLETED once the grace has passed and the issue is in the library', async () => {
        requestsAt([
            importingRequest({ updatedAt: new Date(Date.now() - IMPORT_RECONCILE_GRACE_MS - 60_000) })
        ]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_1' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
    });

    it('matches a request by its exact id inside the batch JSON, quotes included', async () => {
        requestsAt([importingRequest({ id: 'abc123' })]);
        mocks.handoffFindMany.mockResolvedValue([{ outcome: 'IMPORTED' }]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        await reconcileImportHandoffs();

        expect(mocks.handoffFindMany).toHaveBeenCalledWith({
            where: { requestIds: { contains: '"abc123"' } },
            select: { outcome: true }
        });
    });

    // #240 PR B (review, hankscafe): NEEDS_REVIEW is a verdict about a moment, not forever. The
    // window between "routed" and "imported" is minutes to hours, and a pack imported by another
    // route than the Smart Matcher lands later still — so every cycle re-asks the library.
    it('closes a NEEDS_REVIEW request as COMPLETED, with the "available" alert, once its issue is in the library', async () => {
        requestsAt([reviewedRequest()]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });

        expect(mocks.issueIsInLibrary).toHaveBeenCalledWith({
            volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '37'
        });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_1' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
        expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            title: 'Issue #37 — X-Men #34-40 (2004)',
            description: expect.stringContaining('since the review')
        }));
        // It was never an IMPORTING request, so no handoff row is consulted for it.
        expect(mocks.handoffFindMany).not.toHaveBeenCalled();
    });

    it('leaves a NEEDS_REVIEW request alone while its issue is still not in the library', async () => {
        requestsAt([reviewedRequest()]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 0, waiting: 0 });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
        expect(mocks.sendAlert).not.toHaveBeenCalled();
    });

    it('does not guess for a NEEDS_REVIEW request that is not for one issue', async () => {
        requestsAt([
            reviewedRequest({ id: 'req_pack', issueNumber: null, activeDownloadName: 'Invincible Vol. 1-25' }),
            reviewedRequest({ id: 'req_38', issueNumber: '38' }),
        ]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await reconcileImportHandoffs();

        // Only the row that names an issue was asked about, and neither was closed.
        expect(mocks.issueIsInLibrary).toHaveBeenCalledTimes(1);
        expect(mocks.issueIsInLibrary).toHaveBeenCalledWith({
            volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '38'
        });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    // hankscafe's first review point: `issueIsInLibrary` is false by definition for a request that
    // names no issue, so a pack-shaped request whose files are on disk closed NEEDS_REVIEW. The
    // batch's own tally answers for it instead: something imported is an arrival, nothing is not.
    it('closes a request that names no issue on the batch itself: files that reached the library are an arrival', async () => {
        requestsAt([importingRequest({ id: 'req_pack', issueNumber: null, activeDownloadName: 'Invincible Vol. 1-25' })]);
        handoffRows([
            { outcome: 'IMPORTED', requestIds: ['req_pack'] },
            { outcome: 'IMPORTED', requestIds: ['req_pack'] },
            { outcome: 'IMPORTED', requestIds: ['req_pack'] },
        ]);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });

        // Nothing to look up: the library is never asked for a request with no issue number.
        expect(mocks.issueIsInLibrary).not.toHaveBeenCalled();
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_pack' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            title: 'Invincible Vol. 1-25 - 3 Files'
        }));
    });

    it('and closes it NEEDS_REVIEW when the batch imported nothing', async () => {
        requestsAt([importingRequest({ id: 'req_pack', issueNumber: null, activeDownloadName: 'Invincible Vol. 1-25' })]);
        handoffRows([{ outcome: 'UNMATCHED', requestIds: ['req_pack'] }]);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: 'req_pack' }, data: { status: 'NEEDS_REVIEW' } });
        expect(mocks.sendAlert).toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            description: expect.stringContaining('the pack did not reach your library')
        }));
    });

    // hankscafe's second review point: a batch whose rows are never stamped (an old engine, a sweep
    // that never ran, the one exit that used to park a file without stamping) waited forever.
    it('judges a batch that never finished stamping once the import is past IMPORTING_STALE_MS', async () => {
        requestsAt([importingRequest({ updatedAt: new Date(Date.now() - IMPORTING_STALE_MS - 60_000) })]);
        handoffRows([{ outcome: 'IMPORTED', requestIds: ['req_1'] }, { outcome: 'PENDING', requestIds: ['req_1'] }]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });
    });

    it('and hands it to a person, saying the batch never reported back, when nothing arrived', async () => {
        requestsAt([importingRequest({ updatedAt: new Date(Date.now() - IMPORTING_STALE_MS - 60_000) })]);
        handoffRows([{ outcome: 'PENDING', requestIds: ['req_1'] }]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.sendAlert).toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            description: expect.stringContaining('never reported back')
        }));
    });

    it('still waits on a young batch that is only partly stamped', async () => {
        requestsAt([importingRequest({ updatedAt: new Date(Date.now() - 5 * 60_000) })]);
        handoffRows([{ outcome: 'IMPORTED', requestIds: ['req_1'] }, { outcome: 'PENDING', requestIds: ['req_1'] }]);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 0, waiting: 1 });
    });

    // hankscafe's third review point: a joiner has no rows, so it was judged 30 minutes after the
    // join although the batch it joined may run for hours. It waits on that batch now.
    it('waits on the batch a row-less request joined, past its own grace, while that batch is still PENDING', async () => {
        requestsAt([
            importingRequest({
                id: 'req_joiner', downloadLink: 'https://host/pack',
                updatedAt: new Date(Date.now() - IMPORT_RECONCILE_GRACE_MS - 60_000),
            }),
            importingRequest({ id: 'req_lead', downloadLink: 'https://host/pack' }),
        ]);
        handoffRows([{ outcome: 'PENDING', requestIds: ['req_lead'] }]);

        // Both stay: the lead because its file is unstamped, the joiner because it waits on it.
        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 0, waiting: 2 });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
        expect(mocks.sendAlert).not.toHaveBeenCalled();
    });

    it('judges the joiner on the joined batch once it settled — not with the "never reported back" alert', async () => {
        requestsAt([
            importingRequest({ id: 'req_joiner', downloadLink: 'https://host/pack' }),
            importingRequest({ id: 'req_lead', downloadLink: 'https://host/pack' }),
        ]);
        handoffRows([{ outcome: 'UNMATCHED', batchId: 'b1', requestIds: ['req_lead'], createdAt: new Date() }]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 2, waiting: 0 });
        expect(mocks.sendAlert).not.toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            description: expect.stringContaining('never reported back')
        }));
    });

    it('answers a joiner with the newest batch on its link, never with an older settled one', async () => {
        requestsAt([
            importingRequest({
                id: 'req_joiner', issueNumber: null, activeDownloadName: 'Invincible Vol. 1-25',
                downloadLink: 'https://host/pack',
            }),
            importingRequest({ id: 'req_lead', downloadLink: 'https://host/pack' }),
        ]);
        handoffRows([
            { outcome: 'IMPORTED', batchId: 'b_old', requestIds: ['req_lead'], createdAt: new Date('2026-01-01') },
            { outcome: 'UNMATCHED', batchId: 'b_new', requestIds: ['req_lead'], createdAt: new Date('2026-10-01') },
        ]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        // The last batch said nothing arrived, so the joiner is not closed as done on the older
        // batch's imported file.
        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 2, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: 'req_joiner' }, data: { status: 'NEEDS_REVIEW' } });
    });

    // hankscafe's round-2 probe, verbatim: a joiner and its lead, both past the stale window, on a
    // batch still PENDING. Waiting on that batch has to carry the same bound as waiting on rows of
    // one's own, or nothing ever changes those rows and the joiner stays IMPORTING forever.
    it('judges a joiner past the stale window too, when the batch it joined never finishes stamping', async () => {
        const old = new Date(Date.now() - IMPORTING_STALE_MS - 60_000);
        requestsAt([
            importingRequest({ id: 'req_joiner', downloadLink: 'https://host/pack', updatedAt: old }),
            importingRequest({ id: 'req_lead', downloadLink: 'https://host/pack', updatedAt: old }),
        ]);
        handoffRows([{ outcome: 'PENDING', batchId: 'b1', requestIds: ['req_lead'], createdAt: old }]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 2, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: 'req_joiner' }, data: { status: 'NEEDS_REVIEW' } });
        // The joined batch's own pending count gives the joiner the same wording as the lead.
        expect(mocks.sendAlert).toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            description: expect.stringContaining('never reported back')
        }));
    });

    it('closes a stale joiner as COMPLETED when the joined batch did import, and the library has it', async () => {
        const old = new Date(Date.now() - IMPORTING_STALE_MS - 60_000);
        requestsAt([
            importingRequest({ id: 'req_joiner', downloadLink: 'https://host/pack', updatedAt: old }),
            importingRequest({ id: 'req_lead', downloadLink: 'https://host/pack', updatedAt: old }),
        ]);
        handoffRows([
            { outcome: 'IMPORTED', batchId: 'b1', requestIds: ['req_lead'], createdAt: old },
            { outcome: 'PENDING', batchId: 'b1', requestIds: ['req_lead'], createdAt: old },
        ]);
        mocks.issueIsInLibrary.mockResolvedValue(true);

        // Both are judged: the lead on its own rows, the joiner on the batch it joined — not parked
        // for a person just because the wait ran out.
        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 2, review: 0, waiting: 0 });
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            description: expect.stringContaining('has finished importing')
        }));
    });

    // The three smaller points of the same review: the re-check window, and pruning settled rows.
    it('stops re-checking a NEEDS_REVIEW row once it is older than the re-check window', async () => {
        requestsAt([
            reviewedRequest({
                id: 'req_old',
                updatedAt: new Date(Date.now() - IMPORT_REVIEW_RECHECK_WINDOW_MS - 60_000),
            }),
            reviewedRequest({ id: 'req_new', issueNumber: '38' }),
        ]);
        mocks.issueIsInLibrary.mockResolvedValue(false);

        await reconcileImportHandoffs();

        expect(mocks.issueIsInLibrary).toHaveBeenCalledTimes(1);
        expect(mocks.issueIsInLibrary).toHaveBeenCalledWith({
            volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '38'
        });
    });

    it('prunes settled handoff rows past the retention window, and never a pending one', async () => {
        await reconcileImportHandoffs();

        // The cutoff is a moving Date, so assert the bound it was given rather than the instant.
        const { where } = mocks.handoffDeleteMany.mock.calls[0][0];
        expect(where.outcome).toEqual({ not: 'PENDING' });
        const age = Date.now() - where.createdAt.lt.getTime();
        expect(age).toBeGreaterThanOrEqual(IMPORT_HANDOFF_RETENTION_MS);
        expect(age).toBeLessThan(IMPORT_HANDOFF_RETENTION_MS + 60_000);
    });
});

describe('recordImportHandoff', () => {
    beforeEach(() => {
        mocks.handoffCreate.mockClear();
        mocks.transaction.mockClear();
    });

    it('writes one PENDING row per routed file, under the batch, with the request ids beside it', async () => {
        const written = await recordImportHandoff({
            batchId: 'batch_1',
            requestIds: ['req_1', 'req_2'],
            relativePaths: ['a.cbz', 'b.cbz', 'a.cbz'],
            volumeId: '101',
            metadataSource: 'COMICVINE'
        });

        // The duplicate is collapsed: one row per FILE is what makes the engine's key unique.
        expect(written).toBe(2);
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(mocks.handoffCreate).toHaveBeenCalledTimes(2);
        expect(mocks.handoffCreate).toHaveBeenCalledWith({
            data: {
                batchId: 'batch_1',
                requestIds: '["req_1","req_2"]',
                relPath: 'a.cbz',
                volumeId: '101',
                metadataSource: 'COMICVINE',
                outcome: 'PENDING'
            }
        });
        expect(mocks.handoffCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ relPath: 'b.cbz' })
        }));
    });

    it('writes nothing at all when the batch routed no usable path', async () => {
        await expect(recordImportHandoff({
            batchId: 'batch_1', requestIds: ['req_1'], relativePaths: ['', '']
        })).resolves.toBe(0);
        expect(mocks.handoffCreate).not.toHaveBeenCalled();
        expect(mocks.transaction).not.toHaveBeenCalled();
    });
});

describe('the handoff key', () => {
    it('names a routed file relative to the watched folder, so both sides agree without a path', () => {
        expect(watchedRelativePath('/data/watched', '/data/watched/Pack #1.cbz')).toBe('Pack #1.cbz');
        expect(watchedRelativePath('/data/watched', '/data/watched/sub/Pack #1.cbz')).toBe('sub/Pack #1.cbz');
    });

    it('gives every batch its own id (and never an empty one)', () => {
        const a = newImportBatchId();
        expect(a).toMatch(/^WATCHED_SYNC_BATCH_\d+_[a-z0-9]+$/);
        expect(newImportBatchId()).not.toBe(a);
    });
});

// ==== #240 review: the row a file gets BEFORE it is moved into the watched folder, and the two
// corrections it can need afterwards (a move that failed, a rename by the signature fix). ====

describe('the per-file row (written before the move)', () => {
    it('records one PENDING row for one file, under the batch the request will be closed on', async () => {
        const written = await recordPendingHandoff({
            batchId: 'batch_1',
            requestIds: ['req_1', 'req_2'],
            relativePath: 'Invincible 01.cbz',
            volumeId: 'vol_9',
            metadataSource: 'COMICVINE'
        });

        expect(written).toBe(true);
        expect(mocks.handoffCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
            batchId: 'batch_1',
            requestIds: JSON.stringify(['req_1', 'req_2']),
            relPath: 'Invincible 01.cbz',
            volumeId: 'vol_9',
            metadataSource: 'COMICVINE',
            outcome: 'PENDING'
        }) });
    });

    it('never fails the import when the row itself cannot be written', async () => {
        mocks.handoffCreate.mockRejectedValueOnce(new Error('database is locked'));

        const written = await recordPendingHandoff({
            batchId: 'batch_1', requestIds: ['req_1'], relativePath: 'Invincible 01.cbz'
        });

        // The file still has to be routed: the sweep is what settles the row, and a busy table must
        // not turn a pack import into an error.
        expect(written).toBe(false);
    });

    it('takes the row back for a file that never landed, and only a PENDING one', async () => {
        await dropPendingHandoff('batch_1', 'Invincible 01.cbz');

        expect(mocks.handoffDeleteMany).toHaveBeenCalledWith({ where: {
            batchId: 'batch_1',
            relPath: 'Invincible 01.cbz',
            outcome: 'PENDING'
        } });
    });

    it('moves the row to the name the signature fix wrote, while it is still PENDING', async () => {
        await rekeyPendingHandoff('batch_1', 'Fake.cbr', 'Fake.cbz');

        // The PENDING filter is the point: once the sweep has stamped the row, the stamp is the truth
        // and the row stays under the name it was stamped by.
        expect(mocks.handoffUpdateMany).toHaveBeenCalledWith({
            where: { batchId: 'batch_1', relPath: 'Fake.cbr', outcome: 'PENDING' },
            data: { relPath: 'Fake.cbz' }
        });
    });

    it('does nothing when the file kept its name, or when there is no key to follow', async () => {
        await rekeyPendingHandoff('batch_1', 'Invincible 01.cbz', 'Invincible 01.cbz');
        await rekeyPendingHandoff('batch_1', '', 'Fake.cbz');

        expect(mocks.handoffUpdateMany).not.toHaveBeenCalled();
    });
});
