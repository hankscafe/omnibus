// __tests__/lib/insert-cover-core.test.ts
//
// Issue #189 follow-up: embedding an uploaded issue cover as the archive's first page. The core
// owns identity (issueId → file + sidecar paths), the engine call, and the +1 index fixups that
// insertion forces on everything page-anchored:
//   * Issue.pageCount takes the rewritten count (and filePath follows a RAR/7z repack),
//   * every ReadProgress.currentPage shifts UP by one (same content page, new index),
//   * every Bookmark shifts up — processed in DESCENDING order so the per-user
//     @@unique(userId, issueId, pageIndex) can never collide mid-shift (mirror of removal's
//     ascending rule).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import nodePath from 'path';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
    progressFindMany: vi.fn(),
    progressUpdate: vi.fn(),
    bookmarkFindMany: vi.fn(),
    bookmarkUpdate: vi.fn(),
    transaction: vi.fn(),
    auditLog: vi.fn(),
    log: vi.fn(),
    existsSync: vi.fn(),
    readFile: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.issueFindUnique, update: mocks.issueUpdate },
        readProgress: { findMany: mocks.progressFindMany, update: mocks.progressUpdate },
        bookmark: { findMany: mocks.bookmarkFindMany, update: mocks.bookmarkUpdate },
        $transaction: mocks.transaction,
    }
}));
vi.mock('@/lib/utils/paths', () => ({ CONFIG_DIR: '/cfg' }));
vi.mock('@/lib/engine', () => ({ ENGINE_URL: 'http://engine:8000', engineHeaders: (h: any) => h }));
vi.mock('fs', () => ({
    default: { existsSync: mocks.existsSync, promises: { readFile: mocks.readFile } },
    existsSync: mocks.existsSync,
    promises: { readFile: mocks.readFile },
}));

import { embedUploadedCoverIntoArchive } from '@/lib/pages/insert-cover-core';
import { auditLog } from '../helpers/setup-global';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const baseIssue = {
    id: 'i1',
    number: '3',
    filePath: '/data/comics/Series/S 003.cbz',
    series: { name: 'Series' },
};

const engineOk = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;

beforeEach(() => {
    mocks.issueFindUnique.mockResolvedValue(baseIssue);
    mocks.existsSync.mockReturnValue(true);
    mocks.readFile.mockResolvedValue(JPEG_MAGIC);
    mocks.progressFindMany.mockResolvedValue([]);
    mocks.bookmarkFindMany.mockResolvedValue([]);
    mocks.transaction.mockResolvedValue([]);
    mocks.issueUpdate.mockReturnValue({ op: 'issue' });
    mocks.progressUpdate.mockReturnValue({ op: 'progress' });
    mocks.bookmarkUpdate.mockReturnValue({ op: 'bookmark' });
    global.fetch = vi.fn().mockResolvedValue(engineOk({
        new_page_count: 11, entry_name: '000_cover.jpg', new_file_path: baseIssue.filePath,
    }));
});

describe('embedUploadedCoverIntoArchive (issue #189 follow-up)', () => {
    it('calls the engine with the sidecar path and shifts progress + bookmarks up by one', async () => {
        mocks.progressFindMany.mockResolvedValue([
            { id: 'p1', currentPage: 0, totalPages: 10 },
            { id: 'p2', currentPage: 9, totalPages: 10 },
        ]);
        mocks.bookmarkFindMany.mockResolvedValue([
            { id: 'b1', pageIndex: 2 },
            { id: 'b2', pageIndex: 7 },
        ]);

        const out = await embedUploadedCoverIntoArchive('i1', 'admin1', 'upload');

        expect(out).toMatchObject({ ok: true, newPageCount: 11, entryName: '000_cover.jpg', convertedToCbz: false });
        const [url, init] = (global.fetch as any).mock.calls[0];
        expect(url).toBe('http://engine:8000/api/archive/insert-cover');
        expect(JSON.parse(init.body)).toEqual({
            file_path: baseIssue.filePath,
            // path.join keeps this assertion truthful on both dev (Windows) and the container (Linux).
            image_path: nodePath.join('/cfg', 'uploads', 'issue-covers', 'i1.jpg'),
            image_ext: 'jpg',
        });
        // Progress: +1 for everyone, totalPages follows.
        const progressCalls = mocks.progressUpdate.mock.calls.map(c => c[0]);
        expect(progressCalls).toEqual([
            { where: { id: 'p1' }, data: { currentPage: 1, totalPages: 11 } },
            { where: { id: 'p2' }, data: { currentPage: 10, totalPages: 11 } },
        ]);
        // Bookmarks: +1, DESCENDING order (7→8 before 2→3) so the unique index can't collide.
        const bookmarkCalls = mocks.bookmarkUpdate.mock.calls.map(c => c[0]);
        expect(bookmarkCalls).toEqual([
            { where: { id: 'b2' }, data: { pageIndex: 8 } },
            { where: { id: 'b1' }, data: { pageIndex: 3 } },
        ]);
        // One batch transaction; pageCount lands on the issue, filePath unchanged → not written.
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(mocks.issueUpdate.mock.calls[0][0]).toEqual({
            where: { id: 'i1' },
            data: { pageCount: 11 },
        });
        expect(auditLog).toHaveBeenCalledWith('EMBED_ISSUE_COVER', expect.objectContaining({ issueId: 'i1' }), 'admin1');
    });

    it('follows a RAR→CBZ repack by updating filePath and reporting the conversion', async () => {
        (global.fetch as any).mockResolvedValue(engineOk({
            new_page_count: 4, entry_name: '000_cover.png', new_file_path: '/data/comics/Series/S 003.cbz',
        }));
        mocks.issueFindUnique.mockResolvedValue({ ...baseIssue, filePath: '/data/comics/Series/S 003.cbr' });
        mocks.readFile.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // full 8-byte PNG signature

        const out = await embedUploadedCoverIntoArchive('i1', 'admin1', 'matcher');

        expect(out).toMatchObject({ ok: true, convertedToCbz: true, newFilePath: '/data/comics/Series/S 003.cbz' });
        expect(JSON.parse((global.fetch as any).mock.calls[0][1].body).image_ext).toBe('png');
        expect(mocks.issueUpdate.mock.calls[0][0].data).toEqual({ pageCount: 4, filePath: '/data/comics/Series/S 003.cbz' });
    });

    it('refuses when the issue has no file on disk, without calling the engine', async () => {
        mocks.issueFindUnique.mockResolvedValue({ ...baseIssue, filePath: null });
        const out = await embedUploadedCoverIntoArchive('i1', 'admin1');
        expect(out).toMatchObject({ ok: false, status: 404 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('surfaces the engine refusal verbatim and touches nothing', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: false, status: 422, json: async () => ({ error: 'A .cbz with this name already exists next to the original — resolve that first.' }),
        });
        const out = await embedUploadedCoverIntoArchive('i1', 'admin1');
        expect(out).toMatchObject({ ok: false, status: 422 });
        expect((out as any).error).toContain('already exists');
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it('refuses when the uploaded sidecar is missing', async () => {
        mocks.existsSync.mockImplementation((p: string) => !String(p).includes('issue-covers'));
        const out = await embedUploadedCoverIntoArchive('i1', 'admin1');
        expect(out).toMatchObject({ ok: false, status: 404 });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
