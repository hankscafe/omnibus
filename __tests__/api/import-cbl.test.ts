import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/import-cbl/route';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    readingListCreate: vi.fn().mockResolvedValue({ id: 'list_cbl' }),
    readingListItemCreateMany: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany },
        issue: { findMany: mocks.issueFindMany },
        readingList: { create: mocks.readingListCreate },
        readingListItem: { createMany: mocks.readingListItemCreateMany }
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } })
}));

vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('API Route: CBL Import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should parse XML and map ComicRack items to local issues', async () => {
        const mockXml = `<?xml version="1.0"?>
        <ReadingList>
            <Name>X-Men Event</Name>
            <Books>
                <Book Series="X-Men" Number="1" />
                <Book Series="Wolverine" Number="5" />
            </Books>
        </ReadingList>`;

        // Mock the request to bypass Vitest FormData hangs
        const req = {
            formData: async () => ({
                get: (key: string) => {
                    if (key === 'file') return { text: async () => mockXml };
                    if (key === 'name') return 'X-Men Event';
                    if (key === 'isGlobal') return 'false';
                    return null;
                }
            })
        } as any;

        // Mock DB
        mocks.seriesFindMany.mockResolvedValue([
            { id: 's_xmen', name: 'X-Men' }
        ]);
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_1', seriesId: 's_xmen', number: '1' }
        ]);

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(mocks.readingListCreate).toHaveBeenCalled();
        
        // Assert it mapped X-Men #1 to iss_1, and left Wolverine #5 as null (missing)
        expect(mocks.readingListItemCreateMany).toHaveBeenCalledWith({
            data: [
                { listId: 'list_cbl', issueId: 'iss_1', title: 'X-Men #1', order: 0 },
                { listId: 'list_cbl', issueId: null, title: 'Wolverine #5', order: 1 }
            ]
        });
    });
});