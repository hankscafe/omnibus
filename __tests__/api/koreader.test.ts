import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PUT } from '@/app/api/koreader/syncs/progress/route';
import crypto from 'crypto';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    findUniqueOpds: vi.fn(),
    findUniqueApi: vi.fn(),
    koreaderUpsert: vi.fn(),
    findFirstIssue: vi.fn(),
    readProgressUpsert: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Prisma and Logger
vi.mock('@/lib/db', () => ({
    prisma: {
        opdsKey: { findUnique: mocks.findUniqueOpds },
        apiKey: { findUnique: mocks.findUniqueApi },
        koreaderSync: { upsert: mocks.koreaderUpsert },
        issue: { findFirst: mocks.findFirstIssue },
        readProgress: { upsert: mocks.readProgressUpsert }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

const createReq = (headers: Record<string, string>, body: any) => new Request('http://localhost/api/koreader/syncs/progress', {
    method: 'PUT',
    headers: headers,
    body: JSON.stringify(body)
});

describe('Integrations: KOReader Progress Sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should reject requests that are missing the custom KOReader headers', async () => {
        const req = createReq({}, { document: 'book.cbz', percentage: 0.5 });
        const res = await PUT(req);
        
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.authorized).toBe('KO');
    });

    it('should reject requests with invalid OPDS API keys', async () => {
        // Simulate DB finding no match for the hashed key
        mocks.findUniqueOpds.mockResolvedValueOnce(null);
        mocks.findUniqueApi.mockResolvedValueOnce(null);

        const req = createReq({ 'x-auth-user': 'TestUser', 'x-auth-key': 'bad_key' }, {});
        const res = await PUT(req);
        
        expect(res.status).toBe(401);
    });

    it('should accept valid OPDS keys and sync KOReader progress back to the Omnibus Web UI', async () => {
        // 1. Authenticate successfully
        mocks.findUniqueOpds.mockResolvedValueOnce({
            user: { id: 'user_1', username: 'TestUser' }
        });

        // 2. Find the Omnibus Issue that matches the KOReader document
        mocks.findFirstIssue.mockResolvedValueOnce({ id: 'issue_100' });

        // 3. KOReader says the user finished the book (99%+)
        const req = createReq(
            { 'x-auth-user': 'TestUser', 'x-auth-key': 'valid_key' }, 
            { document: '/manga/Naruto/vol_1.cbz', percentage: 0.995, progress: 'page 100', device: 'Kindle', device_id: 'abc' }
        );

        const res = await PUT(req);
        expect(res.status).toBe(200);

        // 4. Assert KOReader sync table was updated
        expect(mocks.koreaderUpsert).toHaveBeenCalled();

        // 5. Assert it cross-synced to the Omnibus Web UI and marked it 100% Complete!
        expect(mocks.readProgressUpsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({ isCompleted: true, currentPage: 100 })
        }));
    });
});