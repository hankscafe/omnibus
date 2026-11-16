// GET /api/progress/recent - the home page's Continue Reading: the issues the user started and hasn't finished.
// beta.045 (found in beta.038's pass): progress on an issue whose file is gone (the row's filePath cleared) was
// still listed, and its card opened the reader on path=null. Only issues with a file are listed now - asked of
// the database, so the shelf's seven cards are all readable ones.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    readProgressFindMany: vi.fn(),
    userFindFirst: vi.fn(),
}));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: { readProgress: { findMany: mocks.readProgressFindMany }, user: { findFirst: mocks.userFindFirst } },
}));

import { GET } from '@/app/api/progress/recent/route';

const progress = (id: string, filePath: string | null, over: Record<string, unknown> = {}) => ({
    id, userId: 'u1', issueId: `i_${id}`, currentPage: 5, totalPages: 20, isCompleted: false,
    issue: {
        id: `i_${id}`, number: '3', filePath, coverUrl: null,
        series: { name: 'Saga', folderPath: '/lib/Image/Saga (2012)', coverUrl: '/covers/saga.jpg', metadataId: '4242', metadataSource: 'COMICVINE' },
    },
    ...over,
});

describe('GET /api/progress/recent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
    });

    it("asks only for the user's unfinished issues that still have a file, seven at most, newest first", async () => {
        mocks.readProgressFindMany.mockResolvedValue([]);

        await GET(new Request('http://localhost/api/progress/recent'));

        expect(mocks.readProgressFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                userId: 'u1', isCompleted: false, totalPages: { gt: 0 },
                issue: { filePath: { not: null }, NOT: { filePath: '' } },
            },
            orderBy: { updatedAt: 'desc' },
            take: 7,
        }));
    });

    it('lists each with the file it opens, and never one without a file', async () => {
        mocks.readProgressFindMany.mockResolvedValue([
            progress('p1', '/lib/Image/Saga (2012)/Saga #003.cbz'),
            progress('p2', null),
            progress('p3', ''),
        ]);

        const data = await (await GET(new Request('http://localhost/api/progress/recent'))).json();

        expect(data.items.map((i: { id: string; filePath: string }) => [i.id, i.filePath])).toEqual([
            ['p1', '/lib/Image/Saga (2012)/Saga #003.cbz'],
        ]);
        // The number comes from the file name when it carries one ("#003"), as before.
        expect(data.items[0]).toMatchObject({ issueNumber: '003', percentage: 25, seriesPath: '/lib/Image/Saga (2012)' });
    });
});
