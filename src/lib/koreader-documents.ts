// KOReader's document IDs for the files Omnibus serves (#211 follow-up).
//
// Every KOReader progress sync names its book by a document ID: with the default "Binary" matching
// method a partial MD5 of the file (util.partialMD5 in KOReader's frontend/util.lua), with "Filename"
// the MD5 of the file's name. Omnibus serves library files byte for byte (the OPDS and web downloads),
// so when it serves one it records both IDs against the issue - and a sync then finds the issue without
// "Send document metadata" or "Use server filenames" (KOReader otherwise names an OPDS download
// "<author> - <title>" from the feed entry).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const SAMPLE_BYTES = 1024;

/**
 * Where KOReader reads its 1 KB samples: `lshift(1024, 2*i)` for i = -1..10. LuaJIT's bit.lshift keeps the
 * low 5 bits of the shift count, so i = -1 shifts by 30 and wraps to 0; JavaScript's `<<` does the same.
 */
export const KOREADER_SAMPLE_OFFSETS: number[] = Array.from({ length: 12 }, (_, k) => SAMPLE_BYTES << (2 * (k - 1)));

/** KOReader's "Binary" document ID for a file: MD5 over its samples, up to the first one past the end. */
export async function koreaderPartialMd5(filePath: string): Promise<string | null> {
    let handle: fs.promises.FileHandle | null = null;
    try {
        handle = await fs.promises.open(filePath, 'r');
        const hash = crypto.createHash('md5');
        const buffer = Buffer.alloc(SAMPLE_BYTES);
        for (const offset of KOREADER_SAMPLE_OFFSETS) {
            const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, offset);
            if (bytesRead === 0) break; // Lua's read() at the end of the file returns nil
            hash.update(buffer.subarray(0, bytesRead));
        }
        return hash.digest('hex');
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}

/** KOReader's "Filename" document ID: the MD5 of the name the file has on the device. */
export function koreaderFilenameDigest(fileName: string): string {
    return crypto.createHash('md5').update(fileName).digest('hex');
}

/**
 * Record both IDs of a file Omnibus is serving for an issue. The filename one assumes the device keeps
 * the served name (KOReader's "Use server filenames"). Never throws - a download must not fail over it.
 */
export async function rememberKoreaderDocument(issueId: string, filePath: string): Promise<void> {
    try {
        const binary = await koreaderPartialMd5(filePath);
        const ids = [
            ...(binary ? [{ digest: binary, method: 'binary' }] : []),
            { digest: koreaderFilenameDigest(path.basename(filePath)), method: 'filename' },
        ];
        for (const { digest, method } of ids) {
            await prisma.koreaderDocument.upsert({
                where: { digest_issueId: { digest, issueId } },
                update: {},
                create: { digest, method, issueId },
            });
        }
    } catch (error) {
        Logger.log(`[KOReader] Could not record the document IDs for ${path.basename(filePath)}: ${getErrorMessage(error)}`, 'debug');
    }
}

/** The same, for a download by path (the web UI's): only when the path is an issue's file. */
export async function rememberKoreaderDocumentForPath(filePath: string): Promise<void> {
    try {
        const issue = await prisma.issue.findFirst({ where: { filePath }, select: { id: true } });
        if (issue) await rememberKoreaderDocument(issue.id, filePath);
    } catch (error) {
        Logger.log(`[KOReader] Could not look up the issue for ${path.basename(filePath)}: ${getErrorMessage(error)}`, 'debug');
    }
}

/** The issue a KOReader document ID was recorded for - null when unknown, or when it points at two. */
export async function findIssueByKoreaderDocument(digest: string): Promise<{ id: string; pageCount: number; filePath: string | null } | null> {
    try {
        const rows = await prisma.koreaderDocument.findMany({
            where: { digest },
            select: { issue: { select: { id: true, pageCount: true, filePath: true } } },
        });
        const issues = new Map(rows.map(r => [r.issue.id, r.issue]));
        return issues.size === 1 ? [...issues.values()][0] : null;
    } catch {
        return null;
    }
}
