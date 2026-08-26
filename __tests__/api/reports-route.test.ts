// __tests__/api/reports-route.test.ts
// Adam's admin-controls ask (2026-08-19): submitting an issue report now alerts admins through
// SystemNotifier (Discord webhooks + email + push channels, each gated by its own event
// subscription). The alert is fire-and-forget — a dead webhook must never fail the user's report.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/reports/route';
import { makePostJson } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    reportCreate: vi.fn(),
    seriesFindUnique: vi.fn(),
    sendAlert: vi.fn().mockResolvedValue(null),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/db', () => ({
    prisma: {
        issueReport: { create: mocks.reportCreate },
        series: { findUnique: mocks.seriesFindUnique },
    }
}));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: mocks.sendAlert } }));

const createReq = makePostJson('http://localhost/api/reports');

describe('API Route: POST /api/reports', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', name: 'hankscafe' } });
        mocks.reportCreate.mockResolvedValue({ id: 'r1', seriesId: 's1', userId: 'u1', description: 'Pages 4-6 are corrupted' });
        mocks.seriesFindUnique.mockResolvedValue({ name: 'Batman', coverUrl: '/api/library/cover?path=x', publisher: 'DC Comics', year: 2011 });
    });

    it('rejects unauthenticated submissions', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);
        const res = await POST(createReq({ seriesId: 's1', description: 'broken' }));
        expect(res.status).toBe(401);
        expect(mocks.reportCreate).not.toHaveBeenCalled();
    });

    it('creates the report and fires the issue_reported alert with series context', async () => {
        const res = await POST(createReq({ seriesId: 's1', description: 'Pages 4-6 are corrupted' }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        expect(mocks.sendAlert).toHaveBeenCalledWith('issue_reported', expect.objectContaining({
            title: 'Batman',
            description: 'Pages 4-6 are corrupted',
            user: 'hankscafe',
        }));
    });

    it('still succeeds when the notifier explodes (fire-and-forget)', async () => {
        mocks.sendAlert.mockRejectedValueOnce(new Error('webhook down'));
        const res = await POST(createReq({ seriesId: 's1', description: 'broken file' }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
    });

    it('still succeeds when the series lookup fails (alert degrades, report lands)', async () => {
        mocks.seriesFindUnique.mockRejectedValueOnce(new Error('db blip'));
        const res = await POST(createReq({ seriesId: 's1', description: 'broken file' }));
        expect(res.status).toBe(200);
        expect(mocks.reportCreate).toHaveBeenCalled();
    });
});
