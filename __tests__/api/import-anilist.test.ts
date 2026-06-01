// __tests__/api/import-anilist.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/import-anilist/route';

const mocks = vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    seriesFindMany: vi.fn(),
    requestFindFirst: vi.fn(),
    requestCreate: vi.fn().mockResolvedValue({ id: 'req_123' }),
    readingListDeleteMany: vi.fn(),
    readingListCreate: vi.fn().mockResolvedValue({ id: 'list_123' }),
    issueFindMany: vi.fn().mockResolvedValue([]),
    readingListItemCreateMany: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany },
        request: { findFirst: mocks.requestFindFirst, create: mocks.requestCreate },
        readingList: { deleteMany: mocks.readingListDeleteMany, create: mocks.readingListCreate },
        issue: { findMany: mocks.issueFindMany },
        readingListItem: { createMany: mocks.readingListItemCreateMany }
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } })
}));

vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/automation', () => ({ processAutomationQueue: vi.fn().mockResolvedValue(true) }));

global.fetch = vi.fn();

describe('API Route: AniList Import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should fuzzy match AniList titles to local series and queue missing ones', async () => {
        // Mock local database having "Attack on Titan"
        mocks.seriesFindMany.mockResolvedValue([
            { id: 'series_aot', name: 'Attack on Titan' }
        ]);

        // Mock AniList GraphQL Response (One matched, one missing)
        vi.mocked(global.fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: {
                    MediaListCollection: {
                        lists: [{
                            name: "Reading",
                            entries: [
                                { media: { title: { english: "Attack on Titan", romaji: "Shingeki no Kyojin" } } },
                                { media: { title: { english: "Chainsaw Man" } } } // Missing locally
                            ]
                        }]
                    }
                }
            })
        } as any);

        mocks.requestFindFirst.mockResolvedValue(null); // Simulate no existing requests for missing manga

        const req = new Request('http://localhost/api/reading-lists/import-anilist', {
            method: 'POST',
            body: JSON.stringify({ username: 'testuser', requestMissing: true, isGlobal: false })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.message).toContain('Synced 1 manga');
        expect(data.message).toContain('Queued 1 missing');

        // Verify the matched series was put in a list
        expect(mocks.readingListCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ name: 'AniList: Reading', userId: 'user_1' })
        }));

        // Verify the missing series was requested
        expect(mocks.requestCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ activeDownloadName: 'Chainsaw Man' })
        }));
    });
});