// src/lib/uploads/chunk-session.ts
//
// Chunked-upload session accounting (field bug 2026-07-27, NAS-backed drop folder): the upload
// route used to verify every chunk's offset against bare fs.stat() of the .part — filesystem
// METADATA. On NFS/SMB mounts the attribute cache serves a STALE size for seconds after another
// request's write, so a healthy session 409'd with a mid-write snapshot number ("expected offset
// 50331648, have 10483589") even though the previous chunk was fully flushed and acknowledged.
//
// The process's own append accounting is the source of truth — we KNOW how many bytes we wrote.
// The filesystem is consulted only when the process has no memory of the session (server
// restarted mid-upload), and then via open()+fstat: open() triggers NFS close-to-open
// revalidation, where a bare stat() can be answered entirely from the attribute cache. One grace
// retry covers the laggiest caches.
//
// Single-process assumption: the standalone server runs one Node process, so a module-level map
// IS the session store (a restart simply falls back to the probe path).

import { open } from 'node:fs/promises';

type Session = { bytes: number; touched: number };
const sessions = new Map<string, Session>();

/** Record the authoritative byte total after a successful append. */
export function noteChunkAppended(uploadId: string, totalBytes: number): void {
    sessions.set(uploadId, { bytes: totalBytes, touched: Date.now() });
}

export function sessionBytes(uploadId: string): number | undefined {
    return sessions.get(uploadId)?.bytes;
}

export function dropSession(uploadId: string): void {
    sessions.delete(uploadId);
}

/** Evict sessions last touched before `cutoffMs` (runs with the route's 24h .part sweep). */
export function sweepSessions(cutoffMs: number): void {
    for (const [id, s] of sessions) {
        if (s.touched < cutoffMs) sessions.delete(id);
    }
}

/**
 * Size probe that defeats NFS attribute caching: open() revalidates under close-to-open
 * consistency, and fstat on the open handle reflects the server's truth. null = file missing.
 */
export async function freshFileSize(filePath: string): Promise<number | null> {
    try {
        const fh = await open(filePath, 'r');
        try {
            return (await fh.stat()).size;
        } finally {
            await fh.close();
        }
    } catch {
        return null;
    }
}

export type ChunkVerdict = { ok: true } | { ok: false; have: number | 'no session' };

/**
 * Decide whether a non-first chunk may append. Trust order: (1) this process's own append
 * accounting — the filesystem is never asked; (2) the injectable `probe` (open()-based size),
 * retried once after `delayMs` for laggy attribute caches.
 */
export async function verifyChunkOffset(opts: {
    chunkOffset: number;
    sessionTotal: number | undefined;
    probe: () => Promise<number | null>;
    delayMs?: number;
}): Promise<ChunkVerdict> {
    const { chunkOffset, sessionTotal, probe } = opts;
    if (sessionTotal !== undefined) {
        return sessionTotal === chunkOffset ? { ok: true } : { ok: false, have: sessionTotal };
    }
    let size = await probe();
    if (size !== chunkOffset) {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 250));
        size = await probe();
    }
    if (size === chunkOffset) return { ok: true };
    return { ok: false, have: size === null ? 'no session' : size };
}

/**
 * Final gate before a chunked .part renames into the drop folder: the on-disk size must equal
 * the accumulated total, or the storage backend lost bytes — a truncated comic must never
 * import. Same one-retry grace as the offset check.
 */
export async function verifyAssembledSize(
    expected: number,
    probe: () => Promise<number | null>,
    delayMs = 250,
): Promise<{ ok: true } | { ok: false; have: number | null }> {
    let size = await probe();
    if (size !== expected) {
        await new Promise((r) => setTimeout(r, delayMs));
        size = await probe();
    }
    return size === expected ? { ok: true } : { ok: false, have: size };
}
