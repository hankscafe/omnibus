import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/import-csv/route';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findManySeries: vi.fn(),
    findManyIssues: vi.fn(),
    createList: vi.fn(),
    createListItems: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.findManySeries },
        issue: { findMany: mocks.findManyIssues },
        readingList: { create: mocks.createList },
        readingListItem: { createMany: mocks.createListItems }
    }
}));


/**
 * FIX: Instead of a real Request object which hangs on .formData() in JSDOM,
 * we create a mock Request that resolves .formData() immediately.
 */
const createMockReq = (csvContent: string, listName: string) => {
    const formData = new FormData();
    formData.append('file', new File([csvContent], 'test.csv', { type: 'text/csv' }));
    formData.append('name', listName);
    
    return {
        formData: async () => formData,
        url: 'http://localhost/api/reading-lists/import-csv',
        // Next.js handlers often check for these
        headers: new Headers({ 'content-type': 'multipart/form-data' })
    } as unknown as Request;
};

describe('Data Processing: CSV Reading List Importer', () => {
    beforeEach(() => {
        // Mock the session for every test
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } });
        
        // Ensure timers don't cause hangs
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should reject a CSV that is missing the required Series/Title column', async () => {
        const badCsv = `Publisher,Year,Rating\nMarvel,2024,5`;
        const req = createMockReq(badCsv, 'My List');
        
        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data.error).toContain("Could not find a 'Series' or 'Title' column");
    });

    it('should parse LOCG CSV formats, fuzzy match local issues, and create a reading list', async () => {
        const validCsv = `"Series","Issue","Publisher"\n"The Amazing Spider-Man","1","Marvel"`;
        const req = createMockReq(validCsv, 'My Epic Pull List');

        // Setup DB mocks
        mocks.findManySeries.mockResolvedValue([{ id: 'series_spidey', name: 'The Amazing Spider-Man' }]);
        mocks.findManyIssues.mockResolvedValue([{ id: 'issue_spidey_1', seriesId: 'series_spidey', number: '1' }]);
        mocks.createList.mockResolvedValue({ id: 'list_123' });

        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(mocks.createList).toHaveBeenCalled();
    });

    it('should successfully create a list of missing items if nothing matches the local database', async () => {
        const validCsv = `Series,Issue\nSome Unknown Comic,1`;
        const req = createMockReq(validCsv, 'My Missing List');

        // Setup DB mocks to return nothing
        mocks.findManySeries.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]);
        mocks.createList.mockResolvedValue({ id: "mock-list-id" });
        mocks.createListItems.mockResolvedValue({ count: 1 });

        const res = await POST(req); 
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        
        // Verify it tried to create items with null issueId (missing)
        expect(mocks.createListItems).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.arrayContaining([
                expect.objectContaining({ issueId: null, title: 'Some Unknown Comic #1' })
            ])
        }));
    });
});