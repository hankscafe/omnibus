// DELETE /api/request?<id> kills the request's own queued search in BullMQ (#240 finding 3).
// Searches now carry a LOW priority so the scheduled jobs jump their backlog — and BullMQ keeps a
// prioritized job in its own `prioritized` state, not in `waiting`. A state list that does not ask
// for it silently stops finding the queued search, and a cancelled request keeps searching.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// One job as the route sees it: the mock answers only the states it was asked for.
type QueuedJob = { id: string; state: string; data?: { requestId?: string }; remove: ReturnType<typeof vi.fn> };

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    requestFindUnique: vi.fn(),
    requestUpdate: vi.fn(),
    requestCount: vi.fn(),
    seriesFindFirst: vi.fn(),
    seriesDelete: vi.fn(),
    issueCount: vi.fn(),
    issueDeleteMany: vi.fn(),
    // Honours the states it is asked for, so a job can never be found by a list that does not include
    // the state it is really in.
    queueGetJobs: vi.fn<(states: string[]) => Promise<QueuedJob[]>>(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/db', () => ({
    prisma: {
        request: { findUnique: mocks.requestFindUnique, update: mocks.requestUpdate, count: mocks.requestCount },
        series: { findFirst: mocks.seriesFindFirst, delete: mocks.seriesDelete },
        issue: { count: mocks.issueCount, deleteMany: mocks.issueDeleteMany },
    }
}));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { getJobs: mocks.queueGetJobs, add: vi.fn() } }));

import { DELETE } from '@/app/api/request/route';

const cancel = (id = 'req_1') => DELETE(new NextRequest(`http://localhost/api/request?id=${id}`, { method: 'DELETE' }));

const queued = (remove: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) => ({
    id: 'SEARCH_req_1', state: 'prioritized', data: { requestId: 'req_1' }, remove, ...over
});

describe('DELETE /api/request — the queued search dies with the request', () => {
    beforeEach(() => {
        mocks.getToken.mockResolvedValue({ id: 'user_1', role: 'USER' });
        mocks.requestFindUnique.mockResolvedValue({
            id: 'req_1', userId: 'user_1', status: 'PENDING', activeDownloadName: 'Batman 001',
            volumeId: '0', metadataSource: 'COMICVINE', downloadLink: null,
        });
        mocks.requestUpdate.mockResolvedValue({});
        mocks.requestCount.mockResolvedValue(0);
        mocks.seriesFindFirst.mockResolvedValue(null);
        mocks.issueCount.mockResolvedValue(0);
        mocks.issueDeleteMany.mockResolvedValue({ count: 0 });
        mocks.seriesDelete.mockResolvedValue({});
    });

    it('removes the search that is waiting in the prioritized state', async () => {
        const remove = vi.fn().mockResolvedValue(undefined);
        mocks.queueGetJobs.mockImplementation(async (states: string[]) =>
            [queued(remove)].filter(job => states.includes(job.state)));

        const res = await cancel();

        expect(res.status).toBe(200);
        // The list the fix touches: a priority moves the job out of `waiting`.
        expect(mocks.queueGetJobs).toHaveBeenCalledWith(
            expect.arrayContaining(['waiting', 'delayed', 'active', 'paused', 'prioritized']));
        expect(remove).toHaveBeenCalled();
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'CANCELLED' })
        }));
    });

    it('leaves a queued search that belongs to another request alone', async () => {
        const remove = vi.fn().mockResolvedValue(undefined);
        mocks.queueGetJobs.mockImplementation(async (states: string[]) =>
            [queued(remove, { id: 'SEARCH_req_2', data: { requestId: 'req_2' } })]
                .filter(job => states.includes(job.state)));

        const res = await cancel();

        expect(res.status).toBe(200);
        expect(remove).not.toHaveBeenCalled();
    });
});
