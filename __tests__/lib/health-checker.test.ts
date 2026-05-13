import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSystemHealthCheck } from '@/lib/health-checker';
import fs from 'fs-extra';

// 1. Hoist Mocks
const mocks = vi.hoisted(() => ({
    upsertSetting: vi.fn(),
    findManySettings: vi.fn(),
    findManyLibraries: vi.fn(),
    findManyRequests: vi.fn().mockResolvedValue([]),
    countDownloadClients: vi.fn().mockResolvedValue(1),
    log: vi.fn(),
    sendAlert: vi.fn().mockResolvedValue(true),
    fetch: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { 
            upsert: mocks.upsertSetting, 
            findMany: mocks.findManySettings 
        },
        library: { findMany: mocks.findManyLibraries },
        downloadClient: { count: mocks.countDownloadClients },
        request: { findMany: mocks.findManyRequests }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: mocks.sendAlert } }));

// Mock fs-extra (which the file uses instead of node:fs)
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        constants: { W_OK: 2, R_OK: 4 },
        promises: {
            access: vi.fn().mockResolvedValue(undefined),
            statfs: vi.fn()
        }
    }
}));

describe('System Health & Diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false })
        });

        // Add ALL required settings to avoid secondary warnings
        mocks.findManySettings.mockResolvedValue([
            { key: 'cv_api_key', value: 'valid_key' },
            { key: 'download_path', value: '/downloads' },
            { key: 'last_backup_sync', value: Date.now().toString() },
            { key: 'cloudflare_block_time', value: '0' },
            { key: 'cv_rate_limit_time', value: '0' },
            { key: 'metron_rate_limit_time', value: '0' }
        ]);

        // Mock BOTH a standard library and a manga library to satisfy lines 85-88
        mocks.findManyLibraries.mockResolvedValue([
            { id: 'lib_1', name: 'Main', path: '/comics', isManga: false },
            { id: 'lib_2', name: 'Manga', path: '/manga', isManga: true }
        ]);
        
        // Ensure some download clients exist to satisfy line 161
        mocks.countDownloadClients.mockResolvedValue(1);
    });

    it('should return DEGRADED status when disk space is critically low (< 2GB)', async () => {
        // Mock 1.5GB free
        const bsize = 1024;
        const bavail = (1.5 * 1024 * 1024 * 1024) / bsize;

        vi.mocked(fs.promises.statfs).mockResolvedValue({ bsize, bavail } as any);

        const result = await runSystemHealthCheck();

        // status becomes 'DEGRADED' if any internal check status is 'error'
        expect(result.status).toBe('DEGRADED'); 
        
        const diskCheck = result.checks.find(c => c.id === 'disk_space');
        expect(diskCheck?.status).toBe('error');
        expect(diskCheck?.message).toContain('Critically full');

        // Verify database persistence for the UI flag
        expect(mocks.upsertSetting).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'is_disk_full' },
            update: { value: 'true' }
        }));
    });

    it('should return a warning when a library folder is read-only', async () => {
        // 10GB free (Healthy space)
        vi.mocked(fs.promises.statfs).mockResolvedValue({ 
            bsize: 1024, 
            bavail: 10 * 1024 * 1024 * 1024 / 1024 
        } as any);

        // Fail write access for the library path
        vi.mocked(fs.promises.access).mockImplementation((path) => {
            if (path === '/comics') return Promise.reject(new Error('EACCES'));
            return Promise.resolve();
        });

        const result = await runSystemHealthCheck();

        // Find check by ID or partial name
        const permCheck = result.checks.find(c => c.id.startsWith('lib_write_'));
        expect(permCheck?.status).toBe('warning');
        expect(permCheck?.message).toContain('read-only');
    });

    it('should return HEALTHY status when all systems are green', async () => {
        // 15GB free
        vi.mocked(fs.promises.statfs).mockResolvedValue({ 
            bsize: 1024, 
            bavail: 15 * 1024 * 1024 * 1024 / 1024 
        } as any);
        
        vi.mocked(fs.promises.access).mockResolvedValue(undefined);

        const result = await runSystemHealthCheck();

        // If this still says WARNING, check result.checks to see which ID has the warning
        if (result.status !== 'HEALTHY') {
            console.log('Failing Checks:', result.checks.filter(c => c.status !== 'ok'));
        }

        expect(result.status).toBe('HEALTHY');
        
        expect(mocks.upsertSetting).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'is_disk_full' },
            update: { value: 'false' }
        }));
    });
});