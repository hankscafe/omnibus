import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindMany: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { issue: { findMany: mocks.issueFindMany } }
}));

vi.mock('fs-extra', () => ({
    existsSync: mocks.existsSync,
    statSync: mocks.statSync,
    default: { existsSync: mocks.existsSync, statSync: mocks.statSync },
}));

import { findDuplicateGroups } from '@/lib/duplicate-detector';

const issue = (id: string, seriesId: string, number: string, filePath: string, seriesName = 'Batman') =>
    ({ id, seriesId, number, filePath, series: { name: seriesName } });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue({ size: 100 });
});

describe('findDuplicateGroups', () => {
    it('flags two existing files for the same series + number as a duplicate (and ignores singletons)', async () => {
        mocks.issueFindMany.mockResolvedValue([
            issue('a', 's1', '1', '/lib/s1/Batman 1.cbz'),
            issue('b', 's1', '1', '/lib/s1/Batman 001.cbz'),
            issue('c', 's1', '2', '/lib/s1/Batman 2.cbz'), // singleton → not a dupe
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].seriesId).toBe('s1');
        expect(groups[0].issueNumber).toBe('1');
        expect(groups[0].files.map(f => f.id).sort()).toEqual(['a', 'b']);
    });

    it('does NOT flag a group when only one of the files actually exists on disk', async () => {
        mocks.existsSync.mockImplementation((p: string) => p.includes('exists'));
        mocks.issueFindMany.mockResolvedValue([
            issue('a', 's1', '1', '/lib/s1/exists.cbz'),
            issue('b', 's1', '1', '/lib/s1/missing.cbz'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(0);
    });

    it('keys by series, so the same number across different series is not a duplicate', async () => {
        mocks.issueFindMany.mockResolvedValue([
            issue('a', 's1', '1', '/lib/s1/a.cbz', 'Batman'),
            issue('b', 's2', '1', '/lib/s2/b.cbz', 'Superman'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(0);
    });

    it('returns an empty array when there are no issues', async () => {
        mocks.issueFindMany.mockResolvedValue([]);
        expect(await findDuplicateGroups()).toEqual([]);
    });
});
