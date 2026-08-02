import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/v1/stats/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    transaction: vi.fn(),
    getAllActiveDownloads: vi.fn(),
    log: vi.fn(),
    seriesCount: vi.fn(),
    issueCount: vi.fn(),
    requestCount: vi.fn(),
    userCount: vi.fn()
}));

vi.mock('../../src/lib/api-auth', () => ({
    validateApiKey: mocks.validateApiKey
}));

vi.mock('../../src/lib/db', () => ({
    prisma: {
        $transaction: mocks.transaction,
        request: { count: mocks.requestCount },
        issue: { count: mocks.issueCount },
        series: { count: mocks.seriesCount },
        user: { count: mocks.userCount }
    }
}));

vi.mock('../../src/lib/download-clients', () => ({
    DownloadService: {
        getAllActiveDownloads: mocks.getAllActiveDownloads
    }
}));

vi.mock('../../src/lib/logger', () => ({
    Logger: {
        log: mocks.log,
        getLogs: vi.fn(),
        clear: vi.fn()
    }
}));

// Prevent GitHub API from holding up the test
global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ([{ tag_name: 'v1.0.0' }])
});

describe('API Route: GET /api/v1/stats', () => {

    it('should return 401 Unauthorized if the API key is invalid', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: false, error: 'Invalid API Key' });

        const req = new NextRequest('http://localhost/api/v1/stats');
        const res = await GET(req);

        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe('Invalid API Key');
    });

    it('should return a 200 OK with the correct stats payload when authenticated', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: true });

        mocks.transaction.mockResolvedValueOnce([10, 150, 20, 5, 2, 3]);

        mocks.getAllActiveDownloads.mockResolvedValueOnce([{ id: '123', name: 'Batman' }]);

        const req = new NextRequest('http://localhost/api/v1/stats', {
            headers: { 'x-api-key': 'valid_key' }
        });
        const res = await GET(req);

        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.data.totalSeries).toBe(10);
        expect(data.data.totalIssues).toBe(150);
        expect(data.data.completed30d).toBe(5);
        expect(data.data.failed30d).toBe(2);
        expect(data.data.activeDownloads).toBe(1);
    });

    it('counts monthly growth from library issues (files on disk), not completed requests', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: true });
        mocks.transaction.mockResolvedValueOnce([10, 150, 20, 5, 2, 3]);
        mocks.getAllActiveDownloads.mockResolvedValueOnce([]);

        const req = new NextRequest('http://localhost/api/v1/stats', {
            headers: { 'x-api-key': 'valid_key' }
        });
        await GET(req);

        // completed30d: issues that physically landed in the library in the window.
        // A scan-populated library has zero completed Requests, so counting the
        // Request table left monthly growth permanently at 0.
        expect(mocks.issueCount).toHaveBeenCalledWith({
            where: {
                filePath: { not: null },
                createdAt: { gte: expect.any(Date) }
            }
        });

        // completed30d must NOT be sourced from the Request table anymore.
        const requestCountArgs = mocks.requestCount.mock.calls.map(c => c[0]);
        for (const args of requestCountArgs) {
            expect(JSON.stringify(args ?? {})).not.toContain('IMPORTED');
        }

        // The 30-day window uses a real cutoff ~30 days back.
        const issueWhere = mocks.issueCount.mock.calls.find(c => c[0]?.where?.filePath)![0].where;
        const cutoff = issueWhere.createdAt.gte as Date;
        const daysBack = (Date.now() - cutoff.getTime()) / 86_400_000;
        expect(daysBack).toBeGreaterThan(29);
        expect(daysBack).toBeLessThan(31);
    });

    it('windows failed30d on updatedAt (when the request failed), matching /api/admin/stats', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: true });
        mocks.transaction.mockResolvedValueOnce([10, 150, 20, 5, 2, 3]);
        mocks.getAllActiveDownloads.mockResolvedValueOnce([]);

        const req = new NextRequest('http://localhost/api/v1/stats', {
            headers: { 'x-api-key': 'valid_key' }
        });
        await GET(req);

        expect(mocks.requestCount).toHaveBeenCalledWith({
            where: {
                status: { in: ['FAILED', 'ERROR', 'STALLED'] },
                updatedAt: { gte: expect.any(Date) }
            }
        });
    });
});