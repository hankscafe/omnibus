import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.findManySeries },
        issue: { findMany: mocks.findManyIssues },
        readingList: { create: mocks.createList },
        readingListItem: { createMany: mocks.createListItems }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

// Helper to create a fake multipart/form-data request
const createFormReq = (csvContent: string, listName: string) => {
    const formData = new FormData();
    // Vitest/Node environment uses standard Blob for File mocking
    formData.append('file', new Blob([csvContent], { type: 'text/csv' }) as File);
    formData.append('name', listName);
    
    return new Request('http://localhost/api/reading-lists/import-csv', {
        method: 'POST',
        body: formData
    });
};

describe('Data Processing: CSV Reading List Importer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } });
    });

    it('should reject a CSV that is missing the required Series/Title column', async () => {
        const badCsv = `Publisher,Year,Rating\nMarvel,2024,5`;
        const req = createFormReq(badCsv, 'My List');
        
        const res = await POST(req);
        expect(res.status).toBe(400);
        
        const data = await res.json();
        expect(data.error).toContain("Could not find a 'Series' or 'Title' column");
    });

    it('should parse LOCG CSV formats, fuzzy match local issues, and create a reading list', async () => {
        // Standard League of Comic Geeks export format
        const validCsv = `"Series","Issue","Publisher"\n"The Amazing Spider-Man","1","Marvel"\n"Batman","12","DC"`;
        const req = createFormReq(validCsv, 'My Epic Pull List');

        // Mock our local database containing these comics
        mocks.findManySeries.mockResolvedValueOnce([
            { id: 'series_spidey', name: 'The Amazing Spider-Man' },
            { id: 'series_batman', name: 'Batman (2016)' } // Note: Testing the fuzzy match logic here!
        ]);

        mocks.findManyIssues.mockResolvedValueOnce([
            { id: 'issue_spidey_1', seriesId: 'series_spidey', number: '1' },
            { id: 'issue_batman_12', seriesId: 'series_batman', number: '12' }
        ]);

        mocks.createList.mockResolvedValueOnce({ id: 'list_123' });

        const res = await POST(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);

        // Assert it created the parent list
        expect(mocks.createList).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ name: 'My Epic Pull List' })
        }));

        // Assert it successfully matched both items and linked them to the list!
        expect(mocks.createListItems).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.arrayContaining([
                expect.objectContaining({ issueId: 'issue_spidey_1', title: 'The Amazing Spider-Man #1' }),
                expect.objectContaining({ issueId: 'issue_batman_12', title: 'Batman #12' })
            ])
        }));
    });

    it('should return a 404 if the CSV parses successfully but nothing matches the local database', async () => {
        const validCsv = `Series,Issue\nUnknown Comic,1`;
        const req = createFormReq(validCsv, 'Empty List');

        mocks.findManySeries.mockResolvedValueOnce([{ id: 'series_batman', name: 'Batman' }]);
        mocks.findManyIssues.mockResolvedValueOnce([]);

        const res = await POST(req);
        
        // Fails with a 404 because none of the items in the CSV exist on your hard drive
        expect(res.status).toBe(404);
        expect(mocks.createList).not.toHaveBeenCalled();
    });
});