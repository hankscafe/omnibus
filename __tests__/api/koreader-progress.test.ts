import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUT as pushProgress } from '@/app/api/koreader/syncs/progress/route';
import { GET as pullProgress } from '@/app/api/koreader/syncs/progress/[document]/route';

const mocks = vi.hoisted(() => ({
    authenticateKoreader: vi.fn(),
    koreaderUpsert: vi.fn(),
    koreaderFindUnique: vi.fn(),
    issueFindMany: vi.fn(),
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

function pushRequest(metadata?: { filename?: string }) {
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
        expect(mocks.readProgressUpsert).toHaveBeenCalledWith({
            where: { userId_issueId: { userId: 'user_1', issueId: 'issue_100' } },
            update: {
                currentPage: 30,
                totalPages: 40,
                isCompleted: false,
            },
            create: {
                userId: 'user_1',
                issueId: 'issue_100',
                currentPage: 30,
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
            update: { currentPage: 75, totalPages: 100, isCompleted: false },
            create: expect.objectContaining({ currentPage: 75, totalPages: 100 }),
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
