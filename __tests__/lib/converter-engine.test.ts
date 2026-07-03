import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convertCbrToCbz } from '@/lib/converter';
import fs from 'fs-extra';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    execFile: vi.fn(),
    findManySettings: vi.fn().mockResolvedValue([]),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.findManySettings },
        issue: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() }
    }
}));

vi.mock('fs-extra', () => ({
    default: {
        ensureDir: vi.fn().mockResolvedValue(true),
        // Signature read fails → treated as "not a zip", routing to the native CLI decoders.
        open: vi.fn().mockRejectedValue(new Error('no fd')),
        read: vi.fn(),
        close: vi.fn(),
        readdir: vi.fn().mockResolvedValue([]),
        existsSync: vi.fn().mockReturnValue(true),
        remove: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('child_process', () => ({ execFile: mocks.execFile, default: { execFile: mocks.execFile } }));
vi.mock('adm-zip', () => ({ default: class AdmZipMock { extractAllTo() {} addLocalFile() {} writeZip() {} } }));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Converter: engine CBR conversion offload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.fetch.mockRejectedValue(new Error('engine unavailable'));
        // Native CLI decoders unavailable in this environment.
        mocks.execFile.mockImplementation((_cmd: any, _args: any, opts: any, cb: any) => {
            const callback = typeof opts === 'function' ? opts : cb;
            callback(new Error('binary not found'));
        });
        mocks.findManySettings.mockResolvedValue([]);
    });

    it('ignores files that are not CBR-family archives', async () => {
        expect(await convertCbrToCbz('/library/Batman 01.cbz')).toBeNull();
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('returns the engine-converted path without running the local pipeline', async () => {
        mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ path: '/library/Batman 01.cbz' }) });

        const result = await convertCbrToCbz('/library/Batman 01.cbr');

        expect(result).toBe('/library/Batman 01.cbz');
        const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(body).toEqual({ path: '/library/Batman 01.cbr' });
        // Local pipeline untouched: no temp dir, no native extraction.
        expect(vi.mocked(fs.ensureDir)).not.toHaveBeenCalled();
        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it('falls back to the local pipeline when the engine is down', async () => {
        const result = await convertCbrToCbz('/library/Batman 01.cbr');

        // Local path ran (temp dir created, native decoders attempted) and failed cleanly → null.
        expect(vi.mocked(fs.ensureDir)).toHaveBeenCalled();
        expect(mocks.execFile).toHaveBeenCalled();
        expect(result).toBeNull();
        // Temp dir cleanup still happened.
        expect(vi.mocked(fs.remove)).toHaveBeenCalled();
    });
});
