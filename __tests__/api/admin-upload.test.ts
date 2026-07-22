// __tests__/api/admin-upload.test.ts
// Manual upload route (beta.015): single-shot regression + the chunked protocol — offset-verified
// appends, finalize-on-last-chunk, 409 on session drift/loss, 413 pre-check, param validation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'stream';
import path from 'path';
import { POST } from '@/app/api/admin/upload/route';

const mocks = vi.hoisted(() => ({
    session: vi.fn(),
    ensureDir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    pathExists: vi.fn(),
    createWriteStream: vi.fn(),
    files: new Map<string, Buffer[]>(),
}));

vi.mock('fs-extra', () => ({
    default: {
        ensureDir: mocks.ensureDir,
        readdir: mocks.readdir,
        stat: mocks.stat,
        remove: mocks.remove,
        move: mocks.move,
        pathExists: mocks.pathExists,
        createWriteStream: mocks.createWriteStream,
    }
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.session }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/utils/paths', () => ({
    WATCHED_DIR: '/watched',
    UNMATCHED_DIR: '/unmatched',
    isPathWithinRoots: () => true,
}));

const upload = (qs: Record<string, string>, body: string, extraHeaders: Record<string, string> = {}) => {
    const params = new URLSearchParams(qs);
    return POST(new Request(`http://localhost/api/admin/upload?${params.toString()}`, {
        method: 'POST',
        body,
        headers: { 'content-length': String(body.length), ...extraHeaders },
    }) as any);
};

const writtenBytes = (needle: string) => {
    for (const [p, chunks] of mocks.files) {
        if (p.includes(needle)) return Buffer.concat(chunks).toString();
    }
    return null;
};

describe('API Route: /api/admin/upload (single-shot + chunked)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.files.clear();
        mocks.session.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.ensureDir.mockResolvedValue(undefined);
        mocks.readdir.mockResolvedValue([]);           // nothing for the stale-part sweep
        mocks.stat.mockRejectedValue(new Error('ENOENT')); // default: no existing session
        mocks.remove.mockResolvedValue(undefined);
        mocks.move.mockResolvedValue(undefined);
        mocks.pathExists.mockResolvedValue(false);     // no filename collisions
        mocks.createWriteStream.mockImplementation((p: string, opts?: { flags?: string }) => {
            const arr = opts?.flags === 'a' ? (mocks.files.get(p) || []) : [];
            mocks.files.set(p, arr);
            return new Writable({ write(chunk, _enc, cb) { arr.push(Buffer.from(chunk)); cb(); } });
        });
    });

    it('single-shot upload streams to a .part and moves into place (regression)', async () => {
        const res = await upload({ destination: 'watched', filename: 'Test.cbz' }, 'hello');
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.filename).toBe('Test.cbz');
        expect(mocks.move).toHaveBeenCalledWith(
            expect.stringContaining('.part'),
            path.join('/watched', 'Test.cbz'),
            { overwrite: false },
        );
        expect(writtenBytes('.upload-')).toBe('hello');
    });

    it('chunked: appends offset-verified chunks and finalizes only on the last one', async () => {
        const qs = { destination: 'watched', filename: 'Big.cbz', uploadId: 'abcd1234', totalChunks: '2' };

        const res0 = await upload({ ...qs, chunkIndex: '0', chunkOffset: '0' }, 'AAAA');
        expect(res0.status).toBe(200);
        expect((await res0.json()).chunkIndex).toBe(0);
        expect(mocks.move).not.toHaveBeenCalled();

        // The session file now "exists" at exactly 4 bytes.
        mocks.stat.mockResolvedValue({ size: 4, mtimeMs: Date.now() });

        const res1 = await upload({ ...qs, chunkIndex: '1', chunkOffset: '4' }, 'BB');
        expect(res1.status).toBe(200);
        const json = await res1.json();
        expect(json.success).toBe(true);
        expect(json.filename).toBe('Big.cbz');
        expect(mocks.move).toHaveBeenCalledTimes(1);
        // Both chunks landed in the SAME deterministic .part, in order.
        expect(writtenBytes('.upload-abcd1234-Big.cbz.part')).toBe('AAAABB');
    });

    it('chunked: 409 when the declared offset does not match the session size', async () => {
        mocks.stat.mockResolvedValue({ size: 999, mtimeMs: Date.now() });
        const res = await upload(
            { destination: 'watched', filename: 'Big.cbz', uploadId: 'abcd1234', totalChunks: '2', chunkIndex: '1', chunkOffset: '4' },
            'BB',
        );
        expect(res.status).toBe(409);
        expect(mocks.move).not.toHaveBeenCalled();
    });

    it('chunked: 409 when a non-first chunk arrives with no session on disk', async () => {
        const res = await upload(
            { destination: 'watched', filename: 'Big.cbz', uploadId: 'abcd1234', totalChunks: '3', chunkIndex: '2', chunkOffset: '96' },
            'CC',
        );
        expect(res.status).toBe(409);
    });

    it('rejects a declared size over the limit with 413 before reading the body', async () => {
        const res = await upload(
            { destination: 'watched', filename: 'Huge.cbz' },
            'tiny',
            { 'content-length': String(3 * 1024 * 1024 * 1024) }, // 3GB declared > 2GB default cap
        );
        expect(res.status).toBe(413);
        expect(mocks.createWriteStream).not.toHaveBeenCalled();
    });

    it('rejects malformed chunk parameters with 400', async () => {
        // uploadId too short
        expect((await upload(
            { destination: 'watched', filename: 'a.cbz', uploadId: 'x', totalChunks: '2', chunkIndex: '0', chunkOffset: '0' }, 'A',
        )).status).toBe(400);
        // negative index
        expect((await upload(
            { destination: 'watched', filename: 'a.cbz', uploadId: 'abcd1234', totalChunks: '2', chunkIndex: '-1', chunkOffset: '0' }, 'A',
        )).status).toBe(400);
        // index beyond totalChunks
        expect((await upload(
            { destination: 'watched', filename: 'a.cbz', uploadId: 'abcd1234', totalChunks: '2', chunkIndex: '2', chunkOffset: '0' }, 'A',
        )).status).toBe(400);
    });

    it('rejects non-admins with 403', async () => {
        mocks.session.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
        const res = await upload({ destination: 'watched', filename: 'a.cbz' }, 'A');
        expect(res.status).toBe(403);
    });
});
