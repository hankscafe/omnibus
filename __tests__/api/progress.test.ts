import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/progress/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    findManyIssues: vi.fn(),
    findUniqueProgress: vi.fn(),
    upsertProgress: vi.fn(),
    upsertDailyStat: vi.fn(),
    getServerSession: vi.fn(),
    log: vi.fn()
}));

// 2. Mock NextAuth
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));

// 3. Mock Prisma
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: mocks.findManyIssues },
        readProgress: { findUnique: mocks.findUniqueProgress, upsert: mocks.upsertProgress },
        dailyReadingStat: { upsert: mocks.upsertDailyStat }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
// Prevent the trophy evaluator from running async during tests
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn().mockResolvedValue(true) }));

const createReq = (body: any) => new Request('http://localhost/api/progress', {
    method: 'POST',
    body: JSON.stringify(body)
});

describe('API Route: Reading Progress Tracker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should reject unauthenticated users', async () => {
        mocks.getServerSession.mockResolvedValueOnce(null);
        
        const req = createReq({ filePath: '/comics/test.cbz', currentPage: 1, totalPages: 100 });
        const res = await POST(req);
        
        expect(res.status).toBe(401);
    });

    it('should mark a book as completed if the user is within 2 pages of the end', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_1' } });
        
        // Mock the DB finding the physical file path
        mocks.findManyIssues.mockResolvedValueOnce([{ id: 'issue_1', filePath: '/comics/batman.cbz' }]);
        // Mock that the user hasn't read this before
        mocks.findUniqueProgress.mockResolvedValueOnce(null);

        // The user reaches page 99 of 100
        const req = createReq({ filePath: '/comics/batman.cbz', currentPage: 99, totalPages: 100 });
        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        
        // Assert that the system automatically marked it as 100% complete
        expect(mocks.upsertProgress).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                isCompleted: true,
                currentPage: 99
            })
        }));
    });
    
    it('should correctly calculate pages read today and update the heatmap stats', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: { id: 'user_1' } });
        mocks.findManyIssues.mockResolvedValueOnce([{ id: 'issue_1', filePath: '/comics/batman.cbz' }]);
        
        // Simulate the user had previously stopped on page 10
        mocks.findUniqueProgress.mockResolvedValueOnce({ currentPage: 10 });
        
        // The user opens the app today and reads up to page 25
        const req = createReq({ filePath: '/comics/batman.cbz', currentPage: 25, totalPages: 100 });
        await POST(req);
        
        // The delta is 15 pages. It should log exactly 15 new pages read today!
        expect(mocks.upsertDailyStat).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ pagesRead: 15 }),
            update: expect.objectContaining({ pagesRead: { increment: 15 } })
        }));
    });
});