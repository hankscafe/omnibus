import { describe, it, expect, vi, beforeEach } from 'vitest';

// #211 follow-up: an OPDS download records the document IDs KOReader will send for that file (its
// partial-MD5 checksum and filename MD5), so the device's progress syncs find the issue on their own.

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    issueFindUnique: vi.fn(),
    remember: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({ prisma: { issue: { findUnique: mocks.issueFindUnique } } }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn(async () => 'ALL'),
    canAccessLibraryId: vi.fn(() => true),
}));
vi.mock('@/lib/koreader-documents', () => ({ rememberKoreaderDocument: mocks.remember }));
vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn(() => true),
        statSync: vi.fn(() => ({ size: 1234 })),
        createReadStream: vi.fn(() => ({ on: vi.fn(), destroy: vi.fn() })),
    },
}));

import { GET } from '@/app/api/opds/download/route';

const FILE = '/library/Saga/Saga 001 (2012).cbz';
const download = () => GET(new Request('http://localhost/api/opds/download?issueId=issue_1'));

describe('GET /api/opds/download - KOReader document IDs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER', canDownload: true } });
        mocks.issueFindUnique.mockResolvedValue({ id: 'issue_1', filePath: FILE, series: { libraryId: 'lib_1' } });
        mocks.remember.mockResolvedValue(undefined);
    });

    it('records them for the issue it serves', async () => {
        const res = await download();

        expect(res.status).toBe(200);
        expect(mocks.remember).toHaveBeenCalledWith('issue_1', FILE);
    });

    it('records nothing for a download it refuses', async () => {
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'USER', canDownload: false } });

        expect((await download()).status).toBe(403);
        expect(mocks.remember).not.toHaveBeenCalled();
    });
});
