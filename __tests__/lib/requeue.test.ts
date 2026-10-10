// __tests__/lib/requeue.test.ts
// requeueWithNextRelease: the "try the next release" step shared by the cron (a client reports a
// failed download) and the importer (#240: a downloaded archive that can't be read). It blocks the
// failed link + release title, puts the request back to PENDING and searches again - or, after three
// tries, parks it STALLED.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    updateRequest: vi.fn().mockResolvedValue({}),
    findFirstSeries: vi.fn(),
    searchAndDownload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: { update: mocks.updateRequest },
        series: { findFirst: mocks.findFirstSeries },
    },
}));
vi.mock('@/lib/automation', () => ({ searchAndDownload: mocks.searchAndDownload }));

import { requeueWithNextRelease } from '@/lib/requeue';

describe('requeueWithNextRelease', () => {
    beforeEach(() => {
        mocks.updateRequest.mockClear();
        mocks.searchAndDownload.mockClear();
        mocks.findFirstSeries.mockReset();
    });

    it('blocks the failed link and release title, re-queues the request and searches again', async () => {
        mocks.findFirstSeries.mockResolvedValue({ name: 'X-Men', year: 2024, publisher: 'Marvel', isManga: false });

        const outcome = await requeueWithNextRelease(
            { id: 'r1', retryCount: 0, failedLinks: '["older"]', downloadLink: 'https://dl.example/x.cbz', volumeId: 'cv_1', activeDownloadName: 'X-Men #38 (2026).cbz' },
            { title: 'X-Men #38 (2026).cbz' },
        );

        expect(outcome).toBe('requeued');
        expect(mocks.updateRequest).toHaveBeenCalledWith({
            where: { id: 'r1' },
            data: {
                status: 'PENDING',
                downloadLink: null,
                retryCount: 1,
                failedLinks: JSON.stringify(['older', 'https://dl.example/x.cbz', 'X-Men #38 (2026).cbz']),
            },
        });
        expect(mocks.searchAndDownload).toHaveBeenCalledWith('r1', 'X-Men #38', '2024', 'Marvel', false, false);
    });

    it('never blocks the same entry twice', async () => {
        mocks.findFirstSeries.mockResolvedValue(null);
        await requeueWithNextRelease(
            { id: 'r1', retryCount: 1, failedLinks: '["https://dl.example/x.cbz"]', downloadLink: 'https://dl.example/x.cbz', volumeId: 'cv_1', activeDownloadName: 'Pack.cbz' },
            { title: 'Pack.cbz' },
        );
        const data = mocks.updateRequest.mock.calls[0][0].data;
        expect(JSON.parse(data.failedLinks)).toEqual(['https://dl.example/x.cbz', 'Pack.cbz']);
        expect(data.retryCount).toBe(2);
    });

    it('without a known series, searches by the request\'s own name and a year from its title', async () => {
        const outcome = await requeueWithNextRelease(
            { id: 'r2', retryCount: 0, failedLinks: null, downloadLink: 'abc123', volumeId: '0', activeDownloadName: 'Invincible Compendium (2018).cbr', name: 'Invincible Compendium' },
            { title: null },
        );
        expect(outcome).toBe('requeued');
        expect(mocks.findFirstSeries).not.toHaveBeenCalled();
        expect(JSON.parse(mocks.updateRequest.mock.calls[0][0].data.failedLinks)).toEqual(['abc123']);
        expect(mocks.searchAndDownload).toHaveBeenCalledWith('r2', 'Invincible Compendium', '2018', 'Unknown', false, false);
    });

    it('after three tries the request is parked STALLED and nothing is searched', async () => {
        const outcome = await requeueWithNextRelease(
            { id: 'r3', retryCount: 3, failedLinks: '[]', downloadLink: 'https://dl.example/y.cbz', volumeId: 'cv_1', activeDownloadName: 'Y.cbz' },
            { title: 'Y.cbz' },
        );
        expect(outcome).toBe('stalled');
        expect(mocks.updateRequest).toHaveBeenCalledWith({ where: { id: 'r3' }, data: { status: 'STALLED' } });
        expect(mocks.searchAndDownload).not.toHaveBeenCalled();
    });
});
