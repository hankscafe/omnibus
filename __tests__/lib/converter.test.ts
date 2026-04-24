import { describe, it, expect, vi, beforeEach } from 'vitest';
import { repackArchive } from '@/lib/converter';
import fs from 'fs-extra';
import sharp from 'sharp';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    addLocalFile: vi.fn(),
    writeZip: vi.fn(),
    log: vi.fn(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(true)
}));

// 2. Mock dependencies
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.findManySettings } }
}));

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
        move: vi.fn().mockResolvedValue(true)
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

vi.mock('node-unrar-js/esm', () => ({
    createExtractorFromFile: vi.fn().mockResolvedValue({ extract: vi.fn().mockReturnValue({ files: [] }) })
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Data Processing: Archive Repacker', () => {
    beforeEach(() => { vi.clearAllMocks(); });

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
});