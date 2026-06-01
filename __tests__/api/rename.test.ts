import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/rename/route';
import { NextRequest } from 'next/server';
import path from 'path';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    systemSettingFindMany: vi.fn(),
    seriesUpdate: vi.fn(),
    issueUpdate: vi.fn(),
    fsMove: vi.fn().mockResolvedValue(true),
    fsExistsSync: vi.fn(),
    log: vi.fn(),
    mockSession: { user: { id: 'admin_1', role: 'ADMIN' } }
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany, update: mocks.seriesUpdate },
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate },
        library: { findMany: mocks.libraryFindMany },
        systemSetting: { findMany: mocks.systemSettingFindMany }
    }
}));

vi.mock('fs-extra', () => ({
    move: mocks.fsMove,
    existsSync: mocks.fsExistsSync,
    ensureDir: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    copy: vi.fn().mockResolvedValue(true),
    default: { 
        move: mocks.fsMove, 
        existsSync: mocks.fsExistsSync, 
        ensureDir: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
        copy: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn().mockResolvedValue(mocks.mockSession.user) }));
vi.mock('@/lib/auth', () => ({ getAuthSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

describe('API Route: Bulk Library Renamer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should physically move and rename files based on pattern matching', async () => {
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib_1', path: '/data/comics' }]);
        mocks.systemSettingFindMany.mockResolvedValue([]); 
        
        // CRITICAL FIX: Make the mock smart. Source folders exist, target files do not.
        mocks.fsExistsSync.mockImplementation((p: string | Buffer | URL) => {
            if (!p) return false;
            // Our test target name will be "Batman #001.cbz". We must tell the route this DOES NOT exist yet.
            if (p.toString().includes('#001')) return false; 
            return true; // The source folders and messy files DO exist
        });

        mocks.seriesFindMany.mockResolvedValue([{
            id: 'series_1',
            libraryId: 'lib_1',
            folderPath: '/data/comics/messy_folder',
            publisher: 'DC Comics',
            name: 'Batman',
            year: 2016,
            isManga: false
        }]);

        mocks.issueFindMany.mockResolvedValue([{
            id: 'issue_1',
            seriesId: 'series_1',
            filePath: '/data/comics/messy_folder/Batman 1.cbz',
            number: '1',
            releaseDate: '2016-01-01'
        }]);

        const req = new NextRequest('http://localhost/api/library/rename', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                seriesIds: ['series_1'],
                folderPattern: '{Publisher}/{Series} ({Year})',
                filePattern: '{Series} #{Issue}'
            })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(data.filesRenamed).toBe(1); // Now this will successfully pass!

        expect(mocks.fsMove).toHaveBeenCalledWith(
            '/data/comics/messy_folder',
            expect.stringContaining(path.normalize('DC Comics/Batman (2016)')),
            expect.any(Object)
        );

        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                filePath: expect.stringContaining('Batman #001.cbz')
            })
        }));
    });
});