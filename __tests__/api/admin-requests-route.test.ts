// GET /api/admin/requests hands Request Management each request's note (beta.008): why it is Not
// Found Yet, Stalled, Needs Review, or still sitting at 100%. My Requests' own route (/api/request)
// maps its fields one by one and does not, so the per-source detail stays with admins.
//
// PATCH (beta.010) is Request Management's "Mark completed": which requests close, and how, is
// request-fulfilment.ts's business (tested there); the route checks who asks, passes the choice on,
// takes the closed requests' queued searches off the queue and writes the audit entry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getServerSession } from 'next-auth/next';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    markRequestsCompleted: vi.fn(),
    getJob: vi.fn(),
    removeJob: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        request: {
            findMany: vi.fn(async () => [{
                id: 'r1', userId: 'u1', volumeId: '101', metadataSource: 'COMICVINE', activeDownloadName: 'Saga #61',
                status: 'NOT_FOUND', progress: 0, downloadLink: null, imageUrl: null, retryCount: 0,
                statusNote: 'GetComics: nothing found · Prowlarr: 12 results, none matched',
                createdAt: new Date('2026-10-20T12:00:00Z'), updatedAt: new Date('2026-10-21T12:00:00Z'),
                user: { username: 'reader' },
            }]),
        },
        series: { findMany: vi.fn(async () => []) },
    },
}));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));
vi.mock('@/lib/request-fulfilment', () => ({ markRequestsCompleted: mocks.markRequestsCompleted }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { getJob: mocks.getJob } }));

import { GET, PATCH } from '@/app/api/admin/requests/route';

describe('GET /api/admin/requests', () => {
    it("includes each request's note", async () => {
        const rows = await (await GET(new Request('http://localhost/api/admin/requests'))).json();
        expect(rows[0]).toMatchObject({ id: 'r1', status: 'NOT_FOUND', statusNote: 'GetComics: nothing found · Prowlarr: 12 results, none matched' });
    });
});

describe('PATCH /api/admin/requests (Mark completed)', () => {
    const patch = (body: unknown) => PATCH(new Request('http://localhost/api/admin/requests', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    const completed = (...ids: string[]) => ids.map(id => ({ id, activeDownloadName: `${id} name` }));

    beforeEach(() => {
        vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'u_admin', name: 'adam', role: 'ADMIN' } } as never);
        mocks.markRequestsCompleted.mockResolvedValue({ completed: completed('r1', 'r2'), skipped: ['r9'] });
        mocks.getJob.mockImplementation(async (id: string) => ({ id, remove: mocks.removeJob }));
        mocks.removeJob.mockResolvedValue(undefined);
    });

    it('refuses anyone but an admin', async () => {
        vi.mocked(getServerSession).mockResolvedValueOnce({ user: { id: 'u1', name: 'reader', role: 'USER' } } as never);

        expect((await patch({ action: 'complete', ids: ['r1'] })).status).toBe(403);
        expect(mocks.markRequestsCompleted).not.toHaveBeenCalled();
    });

    it('refuses a body that names no requests or another action', async () => {
        expect((await patch({ action: 'complete', ids: [] })).status).toBe(400);
        expect((await patch({ action: 'complete' })).status).toBe(400);
        expect((await patch({ action: 'cancel', ids: ['r1'] })).status).toBe(400);
        expect(mocks.markRequestsCompleted).not.toHaveBeenCalled();
    });

    it("marks the chosen requests completed in the admin's name, telling the requester unless asked not to", async () => {
        const res = await patch({ action: 'complete', ids: ['r1', 'r2', 'r9'] });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true, completed: 2, skipped: ['r9'] });
        expect(mocks.markRequestsCompleted).toHaveBeenCalledWith(['r1', 'r2', 'r9'], { notify: true, by: 'adam' });
        expect(auditLog).toHaveBeenCalledWith('COMPLETE_REQUEST', {
            requestIds: ['r1', 'r2'], titles: ['r1 name', 'r2 name'], notify: true,
        }, 'u_admin');

        await patch({ action: 'complete', ids: ['r1'], notify: false });
        expect(mocks.markRequestsCompleted).toHaveBeenLastCalledWith(['r1'], { notify: false, by: 'adam' });
    });

    // The search worker never checks a request's status, so a closed request's queued search would
    // still run - and download the issue.
    it('takes the queued search of every request it closed off the queue', async () => {
        mocks.getJob.mockImplementation(async (id: string) => id === 'SEARCH_r2' ? null : { id, remove: mocks.removeJob });

        await patch({ action: 'complete', ids: ['r1', 'r2', 'r9'] });
        await new Promise(r => setTimeout(r, 0)); // the removal runs after the answer

        expect(mocks.getJob).toHaveBeenCalledWith('SEARCH_r1');
        expect(mocks.getJob).toHaveBeenCalledWith('SEARCH_r2');
        expect(mocks.getJob).not.toHaveBeenCalledWith('SEARCH_r9');
        expect(mocks.removeJob).toHaveBeenCalledTimes(1);
    });

    it('still answers when a queued search cannot be removed', async () => {
        mocks.removeJob.mockRejectedValue(new Error('job is locked'));

        const res = await patch({ action: 'complete', ids: ['r1', 'r2'] });

        expect(res.status).toBe(200);
        expect(auditLog).toHaveBeenCalled();
    });

    // With Redis down BullMQ retries its commands for minutes; the requests are already closed by then,
    // so the answer must not wait on the queue (the dialog sat on its spinner in the lab walk). Awaiting
    // the removal again hangs this test red.
    it('answers while the queue does not', async () => {
        mocks.getJob.mockImplementation(() => new Promise(() => {}));

        const res = await patch({ action: 'complete', ids: ['r1', 'r2'] });

        expect(res.status).toBe(200);
        expect(auditLog).toHaveBeenCalled();
    });
});
