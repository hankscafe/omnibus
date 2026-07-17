// __tests__/lib/utils/archive-pages.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

// Logger writes to disk/console; stub it. Everything else runs against REAL archives in a temp dir —
// the whole point is proving the fast central-directory count agrees with what the reader serves.
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import { countArchivePages, isPageCountable, isEngineCountable } from '@/lib/utils/archive-pages';

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnibus-pages-'));
});
afterEach(async () => {
    await fs.remove(root).catch(() => {});
});

function buildCbz(name: string, entries: Record<string, string>, comment?: string): string {
    const zip = new AdmZip();
    for (const [entryName, content] of Object.entries(entries)) {
        zip.addFile(entryName, Buffer.from(content));
    }
    if (comment) zip.addZipComment(comment);
    const filePath = path.join(root, name);
    zip.writeZip(filePath);
    return filePath;
}

describe('isPageCountable', () => {
    it('accepts zip-family extensions and rejects RAR/7z and empty paths', () => {
        expect(isPageCountable('/comics/a.cbz')).toBe(true);
        expect(isPageCountable('/comics/a.ZIP')).toBe(true);
        expect(isPageCountable('/comics/a.epub')).toBe(true);
        expect(isPageCountable('/comics/a.cbr')).toBe(false);
        expect(isPageCountable('/comics/a.cb7')).toBe(false);
        expect(isPageCountable(null)).toBe(false);
        expect(isPageCountable('')).toBe(false);
    });
});

describe('isEngineCountable', () => {
    it('accepts the engine-native formats (RAR + 7z/.cb7) and rejects zip-family and empty paths', () => {
        // The engine reads these natively (unrar / sevenz-rust2); .cb7 joined here once native 7z
        // reading shipped, so an unconverted cb7 is counted via the engine, not left at 0.
        expect(isEngineCountable('/comics/a.cbr')).toBe(true);
        expect(isEngineCountable('/comics/a.RAR')).toBe(true);
        expect(isEngineCountable('/comics/a.cb7')).toBe(true);
        expect(isEngineCountable('/comics/a.cbz')).toBe(false);
        expect(isEngineCountable('/comics/a.epub')).toBe(false);
        expect(isEngineCountable(null)).toBe(false);
        expect(isEngineCountable('')).toBe(false);
    });
});

describe('countArchivePages', () => {
    it('counts image pages exactly like the reader/OPDS page filter (junk + dirs + __MACOSX excluded)', async () => {
        const filePath = buildCbz('counted.cbz', {
            'page_001.jpg': 'a',
            'page_002.png': 'b',
            'page_003.webp': 'c',
            'nested/page_004.gif': 'd',         // nested images count (reader lists them too)
            'ComicInfo.xml': '<ComicInfo/>',    // metadata — not a page
            '__MACOSX/page_001.jpg': 'junk',    // resource-fork junk — excluded
            'notes.txt': 'junk',                // non-image — excluded
        });

        expect(await countArchivePages(filePath)).toBe(4);
    });

    it('agrees with a full AdmZip parse on the same archive', async () => {
        const filePath = buildCbz('parity.cbz', {
            'a.jpg': '1', 'b.jpeg': '2', 'c.bmp': '3', 'cover.png': '4', 'thumbs.db': 'x',
        });
        const zip = new AdmZip(filePath);
        const admCount = zip.getEntries().filter(e => {
            const n = e.entryName.toLowerCase();
            return !e.isDirectory && !n.includes('__macosx') && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(n);
        }).length;

        expect(await countArchivePages(filePath)).toBe(admCount);
    });

    it('still finds the EOCD when the zip carries a trailing comment', async () => {
        const filePath = buildCbz('commented.cbz', { 'p1.jpg': 'a', 'p2.jpg': 'b' }, 'made with omnibus');
        expect(await countArchivePages(filePath)).toBe(2);
    });

    it('returns 0 for un-countable formats, missing files, and corrupt archives — never throws', async () => {
        // RAR-family: the converter recounts after it produces a CBZ.
        expect(await countArchivePages('/comics/raw.cbr')).toBe(0);
        // Missing file.
        expect(await countArchivePages(path.join(root, 'ghost.cbz'))).toBe(0);
        // Garbage bytes with a .cbz name: fast path AND AdmZip fallback both fail → 0, no throw.
        const corrupt = path.join(root, 'corrupt.cbz');
        await fs.writeFile(corrupt, Buffer.from('this is definitely not a zip archive, not even close'));
        expect(await countArchivePages(corrupt)).toBe(0);
    });
});
