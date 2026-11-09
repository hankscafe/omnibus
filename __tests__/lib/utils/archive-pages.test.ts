// __tests__/lib/utils/archive-pages.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';

// Logger writes to disk/console; stub it. Everything else runs against REAL archives in a temp dir —
// the whole point is proving the fast central-directory count agrees with what the reader serves.

import zlib from 'zlib';
import { countArchivePages, listArchivePages, readZipEntryNames, readZipEntry, readArchivePage, isPageCountable, isEngineCountable } from '@/lib/utils/archive-pages';

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

    it('counts a ZIP64 archive (files over 4 GB)', async () => {
        const filePath = writeZip64Index('big.cbz', ['p1.jpg', 'p2.jpg', 'p3.png', 'ComicInfo.xml']);
        expect(await countArchivePages(filePath)).toBe(3);
    });
});

// A ZIP64 archive the size of a real compendium can't live in a test, but the index reader only
// reads the end records and the central directory - so this writes exactly those (ZIP64 end
// record, its locator, and a classic end record whose fields all say "see ZIP64"), behind a
// stand-in data region. AdmZip can parse this too, but only by reading the whole file into memory,
// which is what fails on a real file over 2 GB - so the ZIP64 cases target readZipEntryNames (the
// index alone, no fallback) directly.
function writeZip64Index(name: string, names: string[]): string {
    const data = Buffer.from('stand-in for the compressed pages');
    const headers = names.map(n => {
        const nameBuf = Buffer.from(n, 'utf8');
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);   // central directory file header
        h.writeUInt16LE(45, 4);           // version made by
        h.writeUInt16LE(45, 6);           // version needed (ZIP64)
        h.writeUInt16LE(0x0800, 8);       // UTF-8 names
        h.writeUInt16LE(nameBuf.length, 28);
        return Buffer.concat([h, nameBuf]);
    });
    const cd = Buffer.concat(headers);
    const cdOffset = data.length;

    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);     // ZIP64 end of central directory record
    z64.writeBigUInt64LE(BigInt(44), 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(BigInt(names.length), 24);
    z64.writeBigUInt64LE(BigInt(names.length), 32);
    z64.writeBigUInt64LE(BigInt(cd.length), 40);
    z64.writeBigUInt64LE(BigInt(cdOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); // ZIP64 end of central directory locator
    locator.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    locator.writeUInt32LE(1, 16);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);    // classic end record: every field defers to ZIP64
    eocd.writeUInt16LE(0xffff, 4);
    eocd.writeUInt16LE(0xffff, 6);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);

    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, Buffer.concat([data, cd, z64, locator, eocd]));
    return filePath;
}

describe('listArchivePages', () => {
    it('lists exactly the page entries AdmZip would, names byte-for-byte (the reader looks pages up by name)', async () => {
        const filePath = buildCbz('listed.cbz', {
            'page_002.jpg': 'b',
            'page_001.jpg': 'a',
            'Spawn - Café #01/page_003.png': 'c', // non-ASCII + nested: the name must match AdmZip's
            'ComicInfo.xml': '<ComicInfo/>',
            '__MACOSX/page_001.jpg': 'junk',
            'notes.txt': 'junk',
        });
        const admNames = new AdmZip(filePath).getEntries()
            .filter(e => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(e.entryName))
            .map(e => e.entryName);

        const names = await listArchivePages(filePath);
        expect([...names].sort()).toEqual([...admNames].sort());
        expect(names).toContain('Spawn - Café #01/page_003.png');
    });

    it('reads a ZIP64 archive from its index alone', async () => {
        const filePath = writeZip64Index('compendium.cbz', ['Vol 1/001.jpg', 'Vol 1/002.jpg', '__MACOSX/001.jpg', 'ComicInfo.xml']);
        expect(await readZipEntryNames(filePath)).toEqual(['Vol 1/001.jpg', 'Vol 1/002.jpg', '__MACOSX/001.jpg', 'ComicInfo.xml']);
        expect(await listArchivePages(filePath)).toEqual(['Vol 1/001.jpg', 'Vol 1/002.jpg']);
    });

    it('lists a regular zip from its index alone, matching AdmZip', async () => {
        const filePath = buildCbz('indexed.cbz', { 'b.jpg': 'b', 'a.jpg': 'a', 'x/ComicInfo.xml': '<ComicInfo/>' });
        const admNames = new AdmZip(filePath).getEntries().map(e => e.entryName);
        expect([...(await readZipEntryNames(filePath))].sort()).toEqual([...admNames].sort());
    });

    it('throws for an archive nothing can read, so the reader can say so', async () => {
        const corrupt = path.join(root, 'corrupt.cbz');
        await fs.writeFile(corrupt, Buffer.from('this is definitely not a zip archive, not even close'));
        await expect(listArchivePages(corrupt)).rejects.toThrow();
    });
});

// A real zip written byte by byte: local headers + data, central directory, end records. Lets the
// tests choose each entry's compression (stored / deflated) and force the ZIP64 layout, where the
// central directory says 0xFFFFFFFF and the real sizes and offsets live in the ZIP64 extra field.
function writeZip(name: string, entries: { name: string; data: Buffer; method: 0 | 8 }[], zip64 = false): string {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const body = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(zip64 ? 45 : 20, 4);
        local.writeUInt16LE(0x0800, 6);                // UTF-8 names
        local.writeUInt16LE(e.method, 8);
        local.writeUInt32LE(zlib.crc32 ? zlib.crc32(e.data) : 0, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, body);

        const extra = Buffer.alloc(zip64 ? 4 + 24 : 0);
        if (zip64) {
            extra.writeUInt16LE(0x0001, 0);
            extra.writeUInt16LE(24, 2);
            extra.writeBigUInt64LE(BigInt(e.data.length), 4);
            extra.writeBigUInt64LE(BigInt(body.length), 12);
            extra.writeBigUInt64LE(BigInt(offset), 20);
        }
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(zip64 ? 45 : 20, 4);
        central.writeUInt16LE(zip64 ? 45 : 20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(e.method, 10);
        central.writeUInt32LE(zlib.crc32 ? zlib.crc32(e.data) : 0, 16);
        central.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
        central.writeUInt32LE(zip64 ? 0xffffffff : e.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(extra.length, 30);
        central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
        centrals.push(central, nameBuf, extra);
        offset += 30 + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const tail: Buffer[] = [];
    if (zip64) {
        const z64 = Buffer.alloc(56);
        z64.writeUInt32LE(0x06064b50, 0);
        z64.writeBigUInt64LE(BigInt(44), 4);
        z64.writeBigUInt64LE(BigInt(entries.length), 24);
        z64.writeBigUInt64LE(BigInt(entries.length), 32);
        z64.writeBigUInt64LE(BigInt(cd.length), 40);
        z64.writeBigUInt64LE(BigInt(offset), 48);
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50, 0);
        locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
        locator.writeUInt32LE(1, 16);
        tail.push(z64, locator);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, Buffer.concat([...locals, cd, ...tail, eocd]));
    return filePath;
}

describe('readZipEntry (one page from the index, without loading the archive)', () => {
    const pageA = Buffer.from('stored page bytes '.repeat(20));
    const pageB = Buffer.from('deflated page bytes '.repeat(50));

    it('reads stored and deflated entries byte-for-byte', async () => {
        const filePath = writeZip('mixed.cbz', [
            { name: 'Vol 1/001.jpg', data: pageA, method: 0 },
            { name: 'Vol 1/002.jpg', data: pageB, method: 8 },
        ]);
        expect(await readZipEntry(filePath, 'Vol 1/001.jpg')).toEqual(pageA);
        expect(await readZipEntry(filePath, 'Vol 1/002.jpg')).toEqual(pageB);
        expect(await readZipEntry(filePath, 'Vol 1/999.jpg')).toBeNull();
    });

    it('finds the real offsets and sizes in a ZIP64 archive\'s extra field', async () => {
        const filePath = writeZip('compendium64.cbz', [
            { name: '001.jpg', data: pageA, method: 0 },
            { name: '002.jpg', data: pageB, method: 8 },
        ], true);
        expect(await readZipEntry(filePath, '002.jpg')).toEqual(pageB);
        expect(await readZipEntry(filePath, '001.jpg')).toEqual(pageA);
    });
});

describe('readArchivePage (what the reader serves when the engine is down)', () => {
    it('returns exactly the bytes AdmZip would, for a real archive', async () => {
        const filePath = buildCbz('real.cbz', {
            'p01.jpg': 'page one '.repeat(30),
            'Spawn - Café #01/p02.png': 'page two '.repeat(30),
        });
        const adm = new AdmZip(filePath);
        for (const entry of ['p01.jpg', 'Spawn - Café #01/p02.png']) {
            expect(await readArchivePage(filePath, entry)).toEqual(adm.getEntry(entry)!.getData());
        }
    });

    it('matches a page the way the reader always has: exact name, backslash form, then file name', async () => {
        const filePath = writeZip('names.cbz', [{ name: String.raw`Vol 2\003.jpg`, data: Buffer.from('three'), method: 0 }]);
        expect((await readArchivePage(filePath, 'Vol 2/003.jpg'))?.toString()).toBe('three');
        expect((await readArchivePage(filePath, 'elsewhere/003.jpg'))?.toString()).toBe('three');
        expect(await readArchivePage(filePath, 'nope.jpg')).toBeNull();
    });
});
