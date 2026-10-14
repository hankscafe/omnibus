// #240 review (hankscafe): the reconciler's verdict for a request that names no issue, proved
// through the REAL `request-dedupe` — his repro used the real `issueNumberOf`/`issueIsInLibrary`
// instead of the mock, because a mock that answers "false" for every lookup hides the bug it was
// meant to catch. His case: an IMPORTING request named "Invincible Vol. 1-25" with three IMPORTED
// rows used to close NEEDS_REVIEW while its files were on disk.
//
// Everything else is mocked: prisma, the notifier, and `ownedCoverageBySeries` (a collected
// edition's coverage, its own subject) so the library question runs for real against the series and
// issue tables.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileImportHandoffs } from '@/lib/import-handoff';

const mocks = vi.hoisted(() => ({
    requestFindMany: vi.fn(),
    requestUpdate: vi.fn(),
    handoffFindMany: vi.fn(),
    handoffDeleteMany: vi.fn(async () => ({ count: 0 })),
    seriesFindFirst: vi.fn(),
    issueFindMany: vi.fn(),
    sendAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findMany: mocks.requestFindMany, update: mocks.requestUpdate },
        importHandoff: {
            findMany: mocks.handoffFindMany,
            deleteMany: mocks.handoffDeleteMany,
        },
        series: { findFirst: mocks.seriesFindFirst },
        issue: { findMany: mocks.issueFindMany },
    }
}));

vi.mock('@/lib/notifications', () => ({
    SystemNotifier: { sendAlert: mocks.sendAlert }
}));

vi.mock('@/lib/coverage-ownership', () => ({
    ownedCoverageBySeries: async () => new Map()
}));

// The library as the reconciler sees it: a series matched on its provider id, with the issues that
// have a file on disk. Nothing here is a stub of the question under test — the real
// `issueIsInLibrary` walks these two tables.
const library = (opts: { seriesId?: string; issueNumbers?: string[] } = {}) => {
    const { seriesId = 'series_1', issueNumbers = [] } = opts;
    mocks.seriesFindFirst.mockResolvedValue(seriesId ? { id: seriesId } : null);
    mocks.issueFindMany.mockResolvedValue(issueNumbers.map(number => ({ number })));
};

const requestsAt = (rows: Record<string, unknown>[]) =>
    mocks.requestFindMany.mockImplementation(async (args: { where?: { status?: string } }) =>
        rows.filter(r => !args?.where?.status || r.status === args.where.status)
    );

const handoffRows = (rows: { outcome: string; requestIds: string[] }[]) =>
    mocks.handoffFindMany.mockImplementation(async (args: { where?: { requestIds?: { contains?: string } } }) => {
        const id = args?.where?.requestIds?.contains?.replace(/"/g, '');
        return rows.filter(r => id && r.requestIds.includes(id));
    });

const packRequest = (over: Record<string, unknown> = {}) => ({
    id: 'req_pack',
    status: 'IMPORTING',
    volumeId: 'volume_101',
    metadataSource: 'COMICVINE',
    issueNumber: null,
    activeDownloadName: 'Invincible Vol. 1-25',
    imageUrl: null,
    downloadLink: null,
    updatedAt: new Date(),
    user: { username: 'nicolas', email: 'n@example.test' },
    ...over,
});

describe('the reconciler, with the real request-dedupe', () => {
    beforeEach(() => {
        requestsAt([]);
        mocks.handoffFindMany.mockResolvedValue([]);
        library({ issueNumbers: [] });
    });

    it('closes a pack-titled request COMPLETED when the batch imported its files', async () => {
        requestsAt([packRequest()]);
        handoffRows([
            { outcome: 'IMPORTED', requestIds: ['req_pack'] },
            { outcome: 'IMPORTED', requestIds: ['req_pack'] },
            { outcome: 'IMPORTED', requestIds: ['req_pack'] },
        ]);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });

        // `issueIsInLibrary` is false by definition here (no number to look for) — which is exactly
        // why it must not be the verdict: the series is never even looked up.
        expect(mocks.seriesFindFirst).not.toHaveBeenCalled();
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_pack' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
        expect(mocks.sendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            title: 'Invincible Vol. 1-25 - 3 Files'
        }));
    });

    it('closes it NEEDS_REVIEW when the batch went to /unmatched — nothing arrived', async () => {
        requestsAt([packRequest()]);
        handoffRows([
            { outcome: 'UNMATCHED', requestIds: ['req_pack'] },
            { outcome: 'UNMATCHED', requestIds: ['req_pack'] },
        ]);

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: 'req_pack' }, data: { status: 'NEEDS_REVIEW' } });
    });

    // The other half of the same question, through the same real helper: a request that DOES name an
    // issue is still decided by the library, and the library is read from the tables.
    it('still decides a request that names an issue on the library, not on the batch', async () => {
        requestsAt([packRequest({ id: 'req_37', issueNumber: '37', activeDownloadName: 'X-Men #37 (2004)' })]);
        handoffRows([{ outcome: 'IMPORTED', requestIds: ['req_37'] }]);
        library({ issueNumbers: ['37'] });

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 1, review: 0, waiting: 0 });
        expect(mocks.seriesFindFirst).toHaveBeenCalled();
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_37' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
    });

    it('parks a request whose number is parsed out of its download name and is not on disk yet', async () => {
        // No stored issueNumber: the identity comes from the name, the real parse (dev's monitor
        // pattern), and the library says the issue is not there.
        requestsAt([packRequest({ id: 'req_38', issueNumber: null, activeDownloadName: 'X-Men #38 (2004)' })]);
        handoffRows([{ outcome: 'IMPORTED', requestIds: ['req_38'] }]);
        library({ issueNumbers: ['37'] });

        await expect(reconcileImportHandoffs()).resolves.toEqual({ completed: 0, review: 1, waiting: 0 });
        expect(mocks.sendAlert).toHaveBeenCalledWith('import_needs_review', expect.objectContaining({
            description: expect.stringContaining('issue #38')
        }));
    });
});
