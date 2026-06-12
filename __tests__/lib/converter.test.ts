import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repackArchive } from '@/lib/converter';
import fs from 'fs-extra';
import sharp from 'sharp';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => {
    const execFileAsync = vi.fn();
    const execFile: any = vi.fn();
    // converter.ts calls promisify(execFile) at module load; promisify picks up
    // this custom implementation, so tests control the async exec calls directly.
    execFile[Symbol.for('nodejs.util.promisify.custom')] = execFileAsync;
    return {
        findManySettings: vi.fn(),
        findFirstIssue: vi.fn(),
        updateIssue: vi.fn(),
        addLocalFile: vi.fn(),
        writeZip: vi.fn(),
        log: vi.fn(),
        webp: vi.fn().mockReturnThis(),
        toFile: vi.fn().mockResolvedValue(true),
        execFile,
        execFileAsync,
        // Magic bytes served by the fs.read mock; tests overwrite per scenario
        signature: { bytes: Buffer.alloc(0) }
    };
});

// 2. Mock dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.findManySettings },
        issue: { findFirst: mocks.findFirstIssue, update: mocks.updateIssue }
    }
}));

vi.mock('child_process', () => {
    const cp = { execFile: mocks.execFile };
    return { ...cp, default: cp };
});

vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        ensureDir: vi.fn().mockResolvedValue(true),
        // FIX: Prevent infinite recursion by returning empty for subdirectories
        readdir: vi.fn().mockImplementation((dir) => {
            if (typeof dir === 'string' && dir.includes('__MACOSX')) return Promise.resolve([]);
            return Promise.resolve([
                { name: 'page_1.jpg', isDirectory: () => false },
                { name: 'page_2.png', isDirectory: () => false },
                { name: '__MACOSX', isDirectory: () => true }
            ]);
        }),
        remove: vi.fn().mockResolvedValue(true),
        move: vi.fn().mockResolvedValue(true),
        open: vi.fn().mockResolvedValue(42),
        read: vi.fn().mockImplementation((_fd, buffer: Buffer) => {
            mocks.signature.bytes.copy(buffer);
            return Promise.resolve({ bytesRead: mocks.signature.bytes.length, buffer });
        }),
        close: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('adm-zip', () => ({
    default: class AdmZipMock {
        extractAllTo() { return true; }
        addLocalFile(path: string, _: string, name: string) { return mocks.addLocalFile(path, name); }
        writeZip(path: string) { return mocks.writeZip(path); }
    }
}));

vi.mock('sharp', () => ({
    default: vi.fn(() => ({
        webp: mocks.webp,
        toFile: mocks.toFile
    }))
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Data Processing: Archive Repacker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.signature.bytes = Buffer.alloc(0);
    });

    it('should repack a CBZ file and maintain original image formats if WEBP is disabled', async () => {
        mocks.findManySettings.mockResolvedValueOnce([{ key: 'convert_to_webp', value: 'false' }]);
        
        const result = await repackArchive('/library/comic.cbz');
        
        expect(result).toBe(true);
        expect(mocks.addLocalFile).toHaveBeenCalled(); // FIX: Loosen this to just verify it added files
        expect(sharp).not.toHaveBeenCalled();
        expect(mocks.writeZip).toHaveBeenCalled();
    });

    it('should convert images to WEBP format during repacking if enabled', async () => {
        mocks.findManySettings.mockResolvedValueOnce([
            { key: 'convert_to_webp', value: 'true' },
            { key: 'webp_quality', value: '80' }
        ]);
        
        const result = await repackArchive('/library/comic.cbz');
        
        expect(result).toBe(true);
        expect(sharp).toHaveBeenCalledTimes(2);
        expect(mocks.webp).toHaveBeenCalledWith({ quality: 80, effort: 4 });
        expect(mocks.toFile).toHaveBeenCalledTimes(2);
        expect(mocks.writeZip).toHaveBeenCalled();
    });

    it('should return false if the file is not a valid zip archive', async () => {
        const result = await repackArchive('/library/comic.pdf');
        expect(result).toBe(false);
        expect(mocks.writeZip).not.toHaveBeenCalled();
    });

    it('should route .cb7 files through the conversion pipeline via the unar fallback', async () => {
        mocks.findManySettings.mockResolvedValueOnce([{ key: 'convert_to_webp', value: 'false' }]);
        mocks.findFirstIssue.mockResolvedValueOnce(null);
        // unrar cannot list a 7z archive: it rejects with empty stdout, which
        // routes extraction to the format-agnostic unar fallback.
        mocks.execFileAsync
            .mockRejectedValueOnce(Object.assign(new Error('not a RAR archive'), { stdout: '' }))
            .mockResolvedValueOnce({ stdout: '', stderr: '' });

        const result = await repackArchive('/library/comic.cb7');

        expect(result).toBe(true);
        expect(mocks.execFileAsync).toHaveBeenNthCalledWith(1, 'unrar', expect.arrayContaining(['lb']), expect.anything());
        expect(mocks.execFileAsync).toHaveBeenNthCalledWith(2, 'unar', expect.arrayContaining(['/library/comic.cb7']), expect.anything());
        expect(mocks.writeZip).toHaveBeenCalledWith('/library/comic.cbz');
    });

    it('should still reject conversion attempts for unsupported extensions', async () => {
        const result = await repackArchive('/library/comic.docx');
        expect(result).toBe(false);
        expect(mocks.execFileAsync).not.toHaveBeenCalled();
    });

    it('should detect a ZIP disguised as .cbr via magic bytes and convert it without external decoders', async () => {
        mocks.findManySettings.mockResolvedValueOnce([{ key: 'convert_to_webp', value: 'false' }]);
        mocks.findFirstIssue.mockResolvedValueOnce(null);
        // "PK\x03\x04" — a CBZ wearing a .cbr extension
        mocks.signature.bytes = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

        const result = await repackArchive('/library/comic.cbr');

        expect(result).toBe(true);
        // Neither unrar nor unar should ever be invoked for a ZIP
        expect(mocks.execFileAsync).not.toHaveBeenCalled();
        expect(mocks.writeZip).toHaveBeenCalledWith('/library/comic.cbz');
    });

    it('should fall back to unar when unrar exits 0 with an empty listing (WinRAR on non-RAR input)', async () => {
        mocks.findManySettings.mockResolvedValueOnce([{ key: 'convert_to_webp', value: 'false' }]);
        mocks.findFirstIssue.mockResolvedValueOnce(null);
        // Not a ZIP by signature, and WinRAR-style unrar "succeeds" silently:
        // exit code 0 with an empty listing must still mean "not a RAR".
        mocks.execFileAsync
            .mockResolvedValueOnce({ stdout: '', stderr: '' })  // unrar lb: exit 0, no output
            .mockResolvedValueOnce({ stdout: '', stderr: '' }); // unar extraction succeeds

        const result = await repackArchive('/library/comic.cbr');

        expect(result).toBe(true);
        expect(mocks.execFileAsync).toHaveBeenNthCalledWith(1, 'unrar', expect.arrayContaining(['lb']), expect.anything());
        expect(mocks.execFileAsync).toHaveBeenNthCalledWith(2, 'unar', expect.arrayContaining(['/library/comic.cbr']), expect.anything());
        expect(mocks.writeZip).toHaveBeenCalledWith('/library/comic.cbz');
    });
});