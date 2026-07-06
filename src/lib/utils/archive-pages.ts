// src/lib/utils/archive-pages.ts
//
// Persistent page counting for comic archives. OPDS-PSE clients (Panels, Chunky) decide whether an
// issue is readable from the advertised pse:count, so Issue.pageCount must be populated everywhere a
// file enters or changes in the library — the web reader hides a missing count because it re-lists
// the archive on every open, but OPDS cannot.
//
// The counter reads ONLY the zip End-Of-Central-Directory + central directory (a tail seek of at most
// ~64KB plus the directory itself) instead of loading the whole archive like AdmZip does — cheap
// enough to run across thousands of issues in a scan sweep. AdmZip remains the fallback for archives
// the fast path can't parse (ZIP64, odd trailers).
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { IMAGE_EXT_REGEX } from '@/lib/utils/formats';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

// Zip-family archives the reader can open directly (matches the reader's isZip check). RAR/7z can't
// be counted here — the auto-converter turns them into .cbz and refreshes the count afterwards.
const ZIP_PAGE_EXT_REGEX = /\.(cbz|zip|epub)$/i;

export function isPageCountable(filePath: string | null | undefined): boolean {
    return !!filePath && ZIP_PAGE_EXT_REGEX.test(filePath);
}

// MUST mirror the entry filter used by the reader (reader/pages) and the OPDS page streamer
// (opds/page/[issueId]/[pageIndex]) — the persisted count has to agree with the indexes they serve.
function isPageEntry(entryName: string): boolean {
    const lower = entryName.toLowerCase();
    return !lower.endsWith('/') && !lower.includes('__macosx') && IMAGE_EXT_REGEX.test(lower);
}

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const MAX_COMMENT = 65535;

async function countViaCentralDirectory(filePath: string): Promise<number> {
    const fd = await fs.promises.open(filePath, 'r');
    try {
        const { size } = await fd.stat();
        if (size < 22) throw new Error('too small to be a zip');

        // EOCD sits in the last 22 + comment bytes; scan backwards for its signature.
        const tailLen = Math.min(size, 22 + MAX_COMMENT);
        const tail = Buffer.alloc(tailLen);
        await fd.read(tail, 0, tailLen, size - tailLen);
        let eocd = -1;
        for (let i = tailLen - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
        }
        if (eocd === -1) throw new Error('EOCD signature not found');

        const totalEntries = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
            throw new Error('ZIP64 archive'); // fall back to AdmZip
        }

        const cd = Buffer.alloc(cdSize);
        await fd.read(cd, 0, cdSize, cdOffset);

        let pos = 0, seen = 0, count = 0;
        while (seen < totalEntries && pos + 46 <= cdSize) {
            if (cd.readUInt32LE(pos) !== CDFH_SIG) throw new Error('corrupt central directory');
            const nameLen = cd.readUInt16LE(pos + 28);
            const extraLen = cd.readUInt16LE(pos + 30);
            const commentLen = cd.readUInt16LE(pos + 32);
            if (isPageEntry(cd.toString('utf8', pos + 46, pos + 46 + nameLen))) count++;
            pos += 46 + nameLen + extraLen + commentLen;
            seen++;
        }
        return count;
    } finally {
        await fd.close();
    }
}

/**
 * Count the readable image pages inside a zip-family comic archive. Returns 0 for formats that
 * can't be counted (.cbr/.rar/.cb7 — converted later), missing files, or unreadable archives;
 * it never throws, so callers can use it inline in scan/import/rename flows.
 */
export async function countArchivePages(filePath: string | null | undefined): Promise<number> {
    if (!filePath || !isPageCountable(filePath) || !fs.existsSync(filePath)) return 0;
    try {
        return await countViaCentralDirectory(filePath);
    } catch (fastErr) {
        try {
            const zip = new AdmZip(filePath);
            return zip.getEntries().filter(e => !e.isDirectory && isPageEntry(e.entryName)).length;
        } catch (zipErr) {
            Logger.log(`[archive-pages] Could not count pages in ${path.basename(filePath)}: ${getErrorMessage(zipErr)} (fast path: ${getErrorMessage(fastErr)})`, 'warn');
            return 0;
        }
    }
}
