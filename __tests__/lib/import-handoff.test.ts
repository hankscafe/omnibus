// #240 (realAbitbol, PR B "notify on reality"): the reconciler that closes a request on what the
// watched-folder sweep actually imported. Mocked prisma + notifier, so each case is pinned to the
// exact transition it causes: COMPLETED with one "available" alert, NEEDS_REVIEW with one "needs
// review" alert, or nothing at all while the batch is still in flight.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    reconcileImportHandoffs,
    recordImportHandoff,
    watchedRelativePath,
    newImportBatchId,
    IMPORT_RECONCILE_GRACE_MS,
} from '@/lib/import-handoff';

const mocks = vi.hoisted(() => ({
    requestFindMany: vi.fn(),
    requestUpdate: vi.fn(),
    handoffFindMany: vi.fn(),
    handoffCreate: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    sendAlert: vi.fn().mockResolvedValue(undefined),
    issueIsInLibrary: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findMany: mocks.requestFindMany, update: mocks.requestUpdate },
        importHandoff: { findMany: mocks.handoffFindMany, create: mocks.handoffCreate },
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

// The reconciler asks the request table twice (IMPORTING, then NEEDS_REVIEW). The mock honours the
// query, so a row can never be answered by the population it is not in.
const requestsAt = (rows: Record<string, unknown>[]) =>
    mocks.requestFindMany.mockImplementation(async (args: { where?: { status?: string } }) =>
        rows.filter(r => !args?.where?.status || r.status === args.where.status)
    );

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
            title: expect.stringContaining('1 File'),
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
            title: 'X-Men #34-40 (2004)',
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
