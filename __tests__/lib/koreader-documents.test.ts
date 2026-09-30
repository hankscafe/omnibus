// __tests__/lib/koreader-documents.test.ts
//
// #211 follow-up (realAbitbol): a KOReader progress sync reached its Omnibus issue only through
// "Send document metadata" + "Use server filenames" - KOReader names a downloaded book
// "<author> - <title>.cbz" from the feed entry otherwise, and Omnibus matched that name against the
// library file's. Every sync also carries KOReader's own document ID: with its default "Binary" matching
// method a partial MD5 of the file (util.partialMD5), with "Filename" the MD5 of the file's name.
// Omnibus serves the library file byte for byte, so it records both IDs when it serves one.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), docFindMany: vi.fn(), issueFindFirst: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: {
        koreaderDocument: { upsert: mocks.upsert, findMany: mocks.docFindMany },
        issue: { findFirst: mocks.issueFindFirst },
    },
}));

import {
    KOREADER_SAMPLE_OFFSETS, koreaderPartialMd5, koreaderFilenameDigest,
    rememberKoreaderDocument, rememberKoreaderDocumentForPath, findIssueByKoreaderDocument,
} from '@/lib/koreader-documents';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-kodoc-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeFile = (name: string, size: number) => {
    const bytes = crypto.randomBytes(size);
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return { file, bytes };
};
const md5 = (...parts: Buffer[]) => crypto.createHash('md5').update(Buffer.concat(parts)).digest('hex');

describe('lib: KOReader document IDs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.upsert.mockReset().mockResolvedValue({});
    });

    it('samples where KOReader does: 1 KB at 0, 1 KB, 4 KB … 1 GiB (lshift(1024, 2i) for i = -1..10)', () => {
        // LuaJIT's bit.lshift keeps the low 5 bits of the count, so i = -1 shifts by 30 and wraps to 0.
        expect(KOREADER_SAMPLE_OFFSETS).toEqual([0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824]);
    });

    it('matches KOReader\'s partial MD5: the samples that exist, a short last one included', async () => {
        const { file, bytes } = writeFile('Saga 001 (2012).cbz', 70_000);
        const expected = md5(
            bytes.subarray(0, 1024), bytes.subarray(1024, 2048), bytes.subarray(4096, 5120),
            bytes.subarray(16384, 17408), bytes.subarray(65536, 66560),
        );
        expect(await koreaderPartialMd5(file)).toBe(expected);

        const small = writeFile('tiny.cbz', 600);
        expect(await koreaderPartialMd5(small.file)).toBe(md5(small.bytes));
    });

    it('a missing file has no ID', async () => {
        expect(await koreaderPartialMd5(path.join(dir, 'gone.cbz'))).toBeNull();
    });

    it('the Filename method\'s ID is the MD5 of the file name', () => {
        expect(koreaderFilenameDigest('Saga 001 (2012).cbz')).toBe(crypto.createHash('md5').update('Saga 001 (2012).cbz').digest('hex'));
    });

    it('remembers both IDs for the issue a file was served for', async () => {
        const { file, bytes } = writeFile('Saga 002 (2012).cbz', 3_000);

        await rememberKoreaderDocument('issue_2', file);

        const rows = mocks.upsert.mock.calls.map(([arg]: any[]) => arg.create);
        expect(rows).toEqual([
            { digest: md5(bytes.subarray(0, 1024), bytes.subarray(1024, 2048)), method: 'binary', issueId: 'issue_2' },
            { digest: koreaderFilenameDigest('Saga 002 (2012).cbz'), method: 'filename', issueId: 'issue_2' },
        ]);
        expect(mocks.upsert.mock.calls[0][0].where).toEqual({ digest_issueId: { digest: rows[0].digest, issueId: 'issue_2' } });
    });

    it('never lets a failure reach the download', async () => {
        mocks.upsert.mockRejectedValue(new Error('database is locked'));
        const { file } = writeFile('Saga 003 (2012).cbz', 2_000);

        await expect(rememberKoreaderDocument('issue_3', file)).resolves.toBeUndefined();
        await expect(rememberKoreaderDocument('issue_3', path.join(dir, 'gone.cbz'))).resolves.toBeUndefined();
    });

    it('a web download is remembered for the issue at that path, if there is one', async () => {
        const { file } = writeFile('Saga 004 (2012).cbz', 2_000);
        mocks.issueFindFirst.mockResolvedValueOnce({ id: 'issue_4' }).mockResolvedValueOnce(null);

        await rememberKoreaderDocumentForPath(file);
        await rememberKoreaderDocumentForPath(path.join(dir, 'not-an-issue.cbz'));

        expect(mocks.issueFindFirst).toHaveBeenCalledWith({ where: { filePath: file }, select: { id: true } });
        expect(mocks.upsert.mock.calls.every(([arg]: any[]) => arg.create.issueId === 'issue_4')).toBe(true);
        expect(mocks.upsert).toHaveBeenCalledTimes(2);
    });

    it('finds the one issue a document ID belongs to - none when it points at two', async () => {
        const issue = { id: 'issue_9', pageCount: 258, filePath: '/lib/Saga 009.cbz' };
        mocks.docFindMany.mockResolvedValueOnce([{ issue }, { issue }]);
        expect(await findIssueByKoreaderDocument('abc')).toEqual(issue);
        expect(mocks.docFindMany).toHaveBeenCalledWith({
            where: { digest: 'abc' },
            select: { issue: { select: { id: true, pageCount: true, filePath: true } } },
        });

        mocks.docFindMany.mockResolvedValueOnce([{ issue }, { issue: { ...issue, id: 'issue_10' } }]);
        expect(await findIssueByKoreaderDocument('abc')).toBeNull();

        mocks.docFindMany.mockResolvedValueOnce([]);
        expect(await findIssueByKoreaderDocument('abc')).toBeNull();
    });
});
