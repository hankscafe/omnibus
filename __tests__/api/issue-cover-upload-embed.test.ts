// Issue #189 follow-up: the issue cover-upload route's embed contract. The sidecar save and
// hasCustomCover lock are long-standing behavior; what's pinned here is the NEW flag:
// embedInArchive === true (and only true) hands off to the shared insert-cover core AFTER the
// sidecar exists, and an embed failure degrades to display-only (200 with embedError) instead
// of failing the upload.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
    getServerSession: vi.fn(),
    embedCore: vi.fn(),
    auditLog: vi.fn(),
    log: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { issue: { findUnique: mocks.issueFindUnique, update: mocks.issueUpdate } }
}));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: async () => ({}) }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: mocks.auditLog } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/utils/paths', () => ({ CONFIG_DIR: '/cfg' }));
vi.mock('@/lib/pages/insert-cover-core', () => ({ embedUploadedCoverIntoArchive: mocks.embedCore }));
vi.mock('fs', () => ({
    default: { existsSync: vi.fn().mockReturnValue(false), promises: { writeFile: mocks.writeFile, mkdir: mocks.mkdir, unlink: vi.fn() } },
    existsSync: vi.fn().mockReturnValue(false),
    promises: { writeFile: mocks.writeFile, mkdir: mocks.mkdir, unlink: vi.fn() },
}));

import { POST } from '@/app/api/library/issue/cover-upload/route';

const PNG_1PX = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');

const postReq = (body: any) => new Request('http://localhost/api/library/issue/cover-upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { role: 'ADMIN', id: 'admin1' } });
    mocks.issueFindUnique.mockResolvedValue({ id: 'i1', number: '3', filePath: '/data/x.cbz', series: { name: 'S' } });
    mocks.issueUpdate.mockResolvedValue({});
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
});

describe('POST /api/library/issue/cover-upload — embedInArchive contract', () => {
    it('embeds via the shared core when embedInArchive is true, after saving the sidecar', async () => {
        mocks.embedCore.mockResolvedValue({ ok: true, newPageCount: 12, entryName: '000_cover.png', convertedToCbz: false, newFilePath: null });

        const res = await POST(postReq({ issueId: 'i1', imageBase64: PNG_1PX, embedInArchive: true }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(mocks.writeFile).toHaveBeenCalled();
        expect(mocks.embedCore).toHaveBeenCalledWith('i1', 'admin1', 'upload');
        expect(data).toMatchObject({ success: true, embedded: true, embed: { newPageCount: 12, entryName: '000_cover.png' } });
    });

    it('does not touch the archive when the flag is absent', async () => {
        const res = await POST(postReq({ issueId: 'i1', imageBase64: PNG_1PX }));
        expect(res.status).toBe(200);
        expect(mocks.embedCore).not.toHaveBeenCalled();
        expect((await res.json()).embedded).toBeUndefined();
    });

    it('degrades to display-only (200 + embedError) when the embed fails', async () => {
        mocks.embedCore.mockResolvedValue({ ok: false, status: 502, error: 'The Rust engine is unreachable — embedding the cover needs it. The cover was still saved for display.' });

        const res = await POST(postReq({ issueId: 'i1', imageBase64: PNG_1PX, embedInArchive: true }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.embedded).toBe(false);
        expect(data.embedError).toContain('engine is unreachable');
    });
});
