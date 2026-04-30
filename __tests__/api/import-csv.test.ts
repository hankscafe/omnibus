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

    it('should successfully create a list of missing items if nothing matches the local database', async () => {
        // 1. Setup the mock FormData with a fake CSV
        const formData = new FormData();
        const mockFile = new Blob(['Series,Issue\nSome Unknown Comic,1'], { type: 'text/csv' });
        formData.append('file', mockFile as File);
        formData.append('name', 'My Missing List');
        formData.append('isGlobal', 'false');

        // 2. Create the Request object
        const req = new Request('http://localhost/api/reading-lists/import-csv', {
            method: 'POST',
            body: formData,
        });

        // 3. Mock the database calls using your existing 'mocks' object
        // We ensure series/issues find nothing
        mocks.findManySeries.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]);
        
        // We mock the creation of the list and the items
        mocks.createList.mockResolvedValue({ id: "mock-list-id" });
        mocks.createListItems.mockResolvedValue({ count: 1 });

        // 4. Execute the POST function
        const res = await POST(req); 
        
        // 5. Assertions
        expect(res.status).toBe(200);
        
        // Verify that createList was called (the core change in logic)
        expect(mocks.createList).toHaveBeenCalled();
        
        // Verify that items were created with null issueIds (since nothing matched)
        expect(mocks.createListItems).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.arrayContaining([
                expect.objectContaining({ issueId: null, title: 'Some Unknown Comic #1' })
            ])
        }));
    });
});