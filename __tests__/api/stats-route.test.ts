import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/v1/stats/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    transaction: vi.fn(),
    getAllActiveDownloads: vi.fn(),
    log: vi.fn(),
    count: vi.fn() // FIX: Add a dummy counter function
}));

vi.mock('../../src/lib/api-auth', () => ({
    validateApiKey: mocks.validateApiKey
}));

vi.mock('../../src/lib/db', () => ({
    prisma: {
        $transaction: mocks.transaction,
        // FIX: Provide the missing Prisma models so .count() doesn't crash!
        request: { count: mocks.count },
        issue: { count: mocks.count },
        user: { count: mocks.count }
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
    beforeEach(() => {
        vi.clearAllMocks();
    });

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
        
        mocks.count.mockResolvedValue(0); // Fills in the dummy counts
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
        expect(data.data.activeDownloads).toBe(1);
    });
});