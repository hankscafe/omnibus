import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUT as pushProgress } from '@/app/api/koreader/syncs/progress/route';
import { GET as pullProgress } from '@/app/api/koreader/syncs/progress/[document]/route';

const mocks = vi.hoisted(() => ({
    authenticateKoreader: vi.fn(),
    koreaderUpsert: vi.fn(),
    koreaderFindUnique: vi.fn(),
    issueFindMany: vi.fn(),
    docFindMany: vi.fn(),
    readProgressUpsert: vi.fn(),
    readProgressFindUnique: vi.fn(),
    upsertDailyStat: vi.fn(),
    upsertDailyIssueRead: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/koreader-auth', () => ({
    authenticateKoreader: mocks.authenticateKoreader,
    koreaderUnauthorizedResponse: (message: string) => Response.json({ code: 2001, message }, { status: 401 }),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        koreaderSync: {
            upsert: mocks.koreaderUpsert,
            findUnique: mocks.koreaderFindUnique,
        },
        issue: { findMany: mocks.issueFindMany },
        koreaderDocument: { findMany: mocks.docFindMany },
        readProgress: {
            upsert: mocks.readProgressUpsert,
            findUnique: mocks.readProgressFindUnique,
        },
        dailyReadingStat: { upsert: mocks.upsertDailyStat },
        dailyIssueRead: { upsert: mocks.upsertDailyIssueRead },
    },
}));

vi.mock('@/lib/logger', () => ({
    Logger: { log: mocks.log },
}));

const USER = { id: 'user_1', username: 'nicolas', role: 'USER' };
const AUTH_HEADERS = { 'x-auth-user': 'nicolas', 'x-auth-key': 'client-md5' };

function pushRequest(metadata?: { filename?: string }, overrides: { progress?: string; percentage?: number } = {}) {
    return new Request('http://localhost/api/koreader/syncs/progress', {
        method: 'PUT',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
            document: 'd41d8cd98f00b204e9800998ecf8427e',
            metadata,
            progress: 'page 30',
            percentage: 0.75,
            device: 'Kobo Clara',
            device_id: 'device-1',
            ...overrides,
        }),
    });
}

function pullRequest(document = 'd41d8cd98f00b204e9800998ecf8427e') {
    return new Request(`http://localhost/api/koreader/syncs/progress/${document}`);
}

describe('KOReader progress protocol', () => {
    beforeEach(() => {
        mocks.authenticateKoreader.mockResolvedValue({ user: USER, error: null });
        mocks.readProgressFindUnique.mockResolvedValue(null);
        mocks.readProgressUpsert.mockResolvedValue({});
        mocks.koreaderUpsert.mockResolvedValue({});
        mocks.koreaderFindUnique.mockResolvedValue(null);
        mocks.issueFindMany.mockResolvedValue([]);
        mocks.docFindMany.mockResolvedValue([]);
    });

    it('returns 401 with a readable message on all sync routes', async () => {
        mocks.authenticateKoreader.mockResolvedValue({ user: null, error: 'API key has expired' });
        const response = await pushProgress(pushRequest({ filename: 'Naruto Vol 1.cbz' }));

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            code: 2001,
            message: 'API key has expired',
        });
    });

    it('stores device sync state and binds metadata.filename to the real issue page count', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'issue_100', pageCount: 40, filePath: '/library/Naruto/Naruto Vol 1.cbz' },
        ]);

        const response = await pushProgress(pushRequest({ filename: 'Naruto Vol 1.cbz' }));

        expect(response.status).toBe(200);
        expect(mocks.issueFindMany).toHaveBeenCalledWith({
            where: { filePath: { endsWith: 'Naruto Vol 1.cbz' } },
            select: { id: true, pageCount: true, filePath: true },
        });
        expect(mocks.koreaderUpsert).toHaveBeenCalled();
        // #217: 75% of 40 pages is page 30, stored as the web reader's 0-based index 29.
        expect(mocks.readProgressUpsert).toHaveBeenCalledWith({
            where: { userId_issueId: { userId: 'user_1', issueId: 'issue_100' } },
            update: {
                currentPage: 29,
                totalPages: 40,
                isCompleted: false,
            },
            create: {
                userId: 'user_1',
                issueId: 'issue_100',
                currentPage: 29,
                totalPages: 40,
                isCompleted: false,
            },
        });
    });

    it('uses percentage points only when the issue page count is unknown', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'issue_100', pageCount: 0, filePath: '/library/Naruto/Naruto Vol 1.cbz' },
        ]);

        const response = await pushProgress(pushRequest({ filename: 'Naruto Vol 1.cbz' }));

        expect(response.status).toBe(200);
        expect(mocks.readProgressUpsert).toHaveBeenCalledWith(expect.objectContaining({
            update: { currentPage: 74, totalPages: 100, isCompleted: false },
            create: expect.objectContaining({ currentPage: 74, totalPages: 100 }),
        }));
    });

    // #217 (realAbitbol): a Kobo on page 9 of a 258-page CBZ pushes progress "9" and 0.0348; the web
    // reader must open page 9 - index 8 - not page 10.
    it('stores KOReader\'s page as the web reader\'s 0-based index (#217)', async () => {
        mocks.issueFindMany.mockResolvedValue([{ id: 'issue_100', pageCount: 258, filePath: '/library/Naruto/Naruto Vol 1.cbz' }]);

        await pushProgress(pushRequest({ filename: 'Naruto Vol 1.cbz' }, { progress: '9', percentage: 0.0348 }));

        expect(mocks.readProgressUpsert).toHaveBeenCalledWith(expect.objectContaining({
            update: { currentPage: 8, totalPages: 258, isCompleted: false },
        }));
        // …and the heatmap gets pages 1-9, not 10.
        expect(mocks.upsertDailyIssueRead).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ pagesRead: 9 }),
        }));
    });

    // #211 follow-up: KOReader's own document ID - its default "Binary" partial MD5 - was recorded when
    // Omnibus served the file, so neither "Send document metadata" nor "Use server filenames" is needed.
    it('binds by KOReader\'s document ID for a file Omnibus served - no metadata needed', async () => {
        mocks.docFindMany.mockResolvedValue([{ issue: { id: 'issue_7', pageCount: 258, filePath: '/library/Saga/Saga 007.cbz' } }]);

        const response = await pushProgress(pushRequest(undefined, { progress: '9', percentage: 0.0348 }));

        expect(response.status).toBe(200);
        expect(mocks.docFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { digest: 'd41d8cd98f00b204e9800998ecf8427e' } }));
        expect(mocks.issueFindMany).not.toHaveBeenCalled();
        expect(mocks.readProgressUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { userId_issueId: { userId: 'user_1', issueId: 'issue_7' } },
            update: { currentPage: 8, totalPages: 258, isCompleted: false },
        }));
    });

    it('falls back to metadata.filename when Omnibus never served that document', async () => {
        mocks.issueFindMany.mockResolvedValue([{ id: 'issue_100', pageCount: 40, filePath: '/library/Naruto/Naruto Vol 1.cbz' }]);

        await pushProgress(pushRequest({ filename: 'Naruto Vol 1.cbz' }));

        expect(mocks.docFindMany).toHaveBeenCalled();
        expect(mocks.readProgressUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { userId_issueId: { userId: 'user_1', issueId: 'issue_100' } },
        }));
    });

    it('stores the device sync row but binds no issue when metadata.filename is absent', async () => {
        const response = await pushProgress(pushRequest());

        expect(response.status).toBe(200);
        expect(mocks.koreaderUpsert).toHaveBeenCalled();
        expect(mocks.issueFindMany).not.toHaveBeenCalled();
        expect(mocks.readProgressUpsert).not.toHaveBeenCalled();
    });

    it('returns 200 {} when no stored progress exists', async () => {
        const response = await pullProgress(pullRequest(), {
            params: Promise.resolve({ document: 'd41d8cd98f00b204e9800998ecf8427e' }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({});
    });
});
