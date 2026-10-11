// #240 (realAbitbol): the dedupe that stops the re-download loop. The pure halves (identity, the
// verdict) are tested directly; `settleDuplicateOnLink` is tested against a mocked prisma so the
// three outcomes — download, park, settle — are each pinned to the write (or non-write) they cause.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    issueNumberOf,
    verdictForLinkSiblings,
    issueIsInLibrary,
    notifiedOnSettle,
    settleDuplicateOnLink,
} from '@/lib/request-dedupe';

const mocks = vi.hoisted(() => ({
    requestFindMany: vi.fn(),
    requestFindUnique: vi.fn(),
    requestUpdate: vi.fn(),
    seriesFindFirst: vi.fn(),
    issueFindMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: {
            findMany: mocks.requestFindMany,
            findUnique: mocks.requestFindUnique,
            update: mocks.requestUpdate,
        },
        series: { findFirst: mocks.seriesFindFirst },
        issue: { findMany: mocks.issueFindMany },
    }
}));

describe('issueNumberOf', () => {
    it('prefers the stored issue number over the name the download overwrote', () => {
        expect(issueNumberOf({ issueNumber: '37', activeDownloadName: 'X-Men #34-40 (2004)' })).toBe('37');
    });

    it('falls back to the name parse for rows created before the column existed', () => {
        expect(issueNumberOf({ issueNumber: null, activeDownloadName: 'Spawn #360' })).toBe('360');
    });

    it('has nothing to say about a request that is not for one issue', () => {
        expect(issueNumberOf({ issueNumber: null, activeDownloadName: 'Invincible Vol. 1-25' })).toBeNull();
    });

    it('keeps the negative sign the name parse has always captured (an annual-ish number)', () => {
        expect(issueNumberOf({ issueNumber: null, activeDownloadName: 'Batman #-1' })).toBe('-1');
    });
});

describe('notifiedOnSettle', () => {
    it('keeps the bell quiet when a finished request on the link is the same user\'s', () => {
        // Their own request consumed the pack, so its import already announced the issue.
        expect(notifiedOnSettle([{ status: 'COMPLETED', userId: 'u1' }], 'u1')).toBe(true);
        expect(notifiedOnSettle([{ status: 'IMPORTED', userId: 'u1' }], 'u1')).toBe(true);
    });

    it('rings for a closer whose link was consumed by someone else\'s request', () => {
        expect(notifiedOnSettle([{ status: 'COMPLETED', userId: 'u2' }], 'u1')).toBe(false);
        expect(notifiedOnSettle([{ status: 'COMPLETED' }], 'u1')).toBe(false);
        expect(notifiedOnSettle([{ status: 'COMPLETED', userId: 'u1' }], undefined)).toBe(false);
    });

    it('never counts a sibling that is still downloading as the one that told them', () => {
        expect(notifiedOnSettle([{ status: 'DOWNLOADING', userId: 'u1' }], 'u1')).toBe(false);
    });
});

describe('verdictForLinkSiblings', () => {
    it('downloads when nothing else holds the link', () => {
        expect(verdictForLinkSiblings([], false)).toEqual({ action: 'download' });
    });

    it('parks while a sibling is still downloading the same link', () => {
        expect(verdictForLinkSiblings(['DOWNLOADING'], false)).toEqual({ action: 'park' });
        // A finished sibling beside a live one is still "wait for the live one".
        expect(verdictForLinkSiblings(['COMPLETED', 'DOWNLOADING'], true)).toEqual({ action: 'park' });
    });

    it('joins the wait when a sibling already handed the pack to the watched folder (#240 PR B)', () => {
        expect(verdictForLinkSiblings(['IMPORTING'], false)).toEqual({ action: 'join' });
        // A live download beside a handed-off pack still parks: those bytes are not even on disk yet.
        expect(verdictForLinkSiblings(['IMPORTING', 'DOWNLOADING'], false)).toEqual({ action: 'park' });
    });

    it('settles as COMPLETED when every sibling finished and the issue is in the library', () => {
        expect(verdictForLinkSiblings(['COMPLETED'], true)).toEqual({ action: 'settle', status: 'COMPLETED', reason: 'in-library' });
    });

    it('settles as NEEDS_REVIEW when the bytes were consumed and the issue never arrived', () => {
        expect(verdictForLinkSiblings(['IMPORTED'], false)).toEqual({ action: 'settle', status: 'NEEDS_REVIEW', reason: 'unmatched' });
    });
});

describe('issueIsInLibrary', () => {
    beforeEach(() => {
        mocks.seriesFindFirst.mockResolvedValue({ id: 's1' });
        mocks.issueFindMany.mockResolvedValue([]);
    });

    it('is true for a file-backed issue of the series', async () => {
        mocks.issueFindMany.mockResolvedValue([{ number: '37' }]);
        await expect(issueIsInLibrary({ volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '37' })).resolves.toBe(true);
    });

    it('is true when an owned collected book reprints it', async () => {
        mocks.issueFindMany.mockResolvedValue([{ seriesId: 's1', number: '100', coversIssues: '30-40', attachedVolume: { kind: 'COLLECTED' } }]);
        await expect(issueIsInLibrary({ volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '37' })).resolves.toBe(true);
    });

    it('is false when the number is not on disk', async () => {
        mocks.issueFindMany.mockResolvedValue([{ number: '12' }]);
        await expect(issueIsInLibrary({ volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '37' })).resolves.toBe(false);
    });

    it('asks nothing for a request with no volume or no issue number', async () => {
        await expect(issueIsInLibrary({ volumeId: '0', issueNumber: '37' })).resolves.toBe(false);
        await expect(issueIsInLibrary({ volumeId: '101', issueNumber: null })).resolves.toBe(false);
        expect(mocks.seriesFindFirst).not.toHaveBeenCalled();
    });
});

describe('settleDuplicateOnLink', () => {
    beforeEach(() => {
        mocks.requestFindMany.mockResolvedValue([]);
        mocks.requestFindUnique.mockResolvedValue({
            volumeId: '101', metadataSource: 'COMICVINE', issueNumber: '37', activeDownloadName: 'X-Men #37', userId: 'u1'
        });
        mocks.seriesFindFirst.mockResolvedValue({ id: 's1' });
        mocks.issueFindMany.mockResolvedValue([{ number: '37' }]);
    });

    it('leaves a request alone when no other request holds the link', async () => {
        await expect(settleDuplicateOnLink('https://host/pack.cbz', 'req_new')).resolves.toEqual({ action: 'download' });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    it('parks on a link a sibling is still downloading, and writes nothing itself', async () => {
        mocks.requestFindMany.mockResolvedValue([{ id: 'req_lead', status: 'DOWNLOADING' }]);
        await expect(settleDuplicateOnLink('https://host/pack.cbz', 'req_new')).resolves.toEqual({ action: 'park' });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    it('joins a sibling that has the pack in the watched folder, even beside finished rows (#240 PR B)', async () => {
        // The sibling's bytes are gone but its outcome is not known yet: settling now would be a
        // guess (the issue may be landing), and downloading again is the bandwidth PR A removed.
        mocks.requestFindMany.mockResolvedValue([
            { id: 'req_lead', status: 'IMPORTING' },
            { id: 'req_old', status: 'COMPLETED' }
        ]);

        await expect(settleDuplicateOnLink('https://host/pack.cbz', 'req_new')).resolves.toEqual({ action: 'join' });
        expect(mocks.requestUpdate).not.toHaveBeenCalled();
    });

    it('closes as COMPLETED (and download nothing) when the link is consumed and the issue is owned', async () => {
        mocks.requestFindMany.mockResolvedValue([{ id: 'req_lead', status: 'COMPLETED', userId: 'u1' }]);

        await expect(settleDuplicateOnLink('https://host/pack.cbz', 'req_new')).resolves.toEqual({
            action: 'settle', status: 'COMPLETED', reason: 'in-library'
        });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_new' },
            data: { status: 'COMPLETED', progress: 100, notified: true }
        });
    });

    it('closes as COMPLETED with the bell left to ring when the consumed link was another user\'s', async () => {
        mocks.requestFindMany.mockResolvedValue([{ id: 'req_lead', status: 'COMPLETED', userId: 'u2' }]);

        await expect(settleDuplicateOnLink('https://host/pack.cbz', 'req_new')).resolves.toEqual({
            action: 'settle', status: 'COMPLETED', reason: 'in-library'
        });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_new' },
            data: { status: 'COMPLETED', progress: 100, notified: false }
        });
    });

    it('closes as NEEDS_REVIEW when the link is consumed and the issue never reached the library', async () => {
        mocks.requestFindMany.mockResolvedValue([{ id: 'req_lead', status: 'COMPLETED' }]);
        mocks.issueFindMany.mockResolvedValue([]);

        await expect(settleDuplicateOnLink('https://host/pack.cbz', 'req_new')).resolves.toEqual({
            action: 'settle', status: 'NEEDS_REVIEW', reason: 'unmatched'
        });
        expect(mocks.requestUpdate).toHaveBeenCalledWith({
            where: { id: 'req_new' },
            data: { status: 'NEEDS_REVIEW' }
        });
    });

    it('needs no link to decide', async () => {
        await expect(settleDuplicateOnLink(null, 'req_new')).resolves.toEqual({ action: 'download' });
        expect(mocks.requestFindMany).not.toHaveBeenCalled();
    });
});
