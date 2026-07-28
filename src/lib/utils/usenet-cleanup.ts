// src/lib/utils/usenet-cleanup.ts
//
// Deletes the ORIGINAL usenet download from the client's category folder (issue #198). Every
// external-client import COPIES into the library — that's seed preservation for torrents, but for
// NZBGet/SABnzbd it just strands the source file and its job folder forever. This helper removes
// exactly the path the importer read from, and nothing else.
//
// Torrent clients (qbit/deluge) must never reach this — deleting their payload breaks seeding.
// Callers gate on client type; the type check here is defense in depth, not the primary gate.

import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '../logger';
import { resolveRemotePath } from './path-resolver';
import { WATCHED_DIR } from './paths';

const USENET_CLIENT_TYPES = ['sab', 'nzbget'];

// Windows dev boxes compare paths case-insensitively; the Linux containers don't.
function canon(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when child is strictly inside parent — never equal to it. */
export function isStrictSubPath(parent: string, child: string): boolean {
    const rel = path.relative(canon(parent), canon(child));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Remove a finished usenet job's source (the per-job folder, or the bare file in a flat layout)
 * from the download client's folder. Returns true only when something was actually deleted.
 * Never throws — a failed delete (read-only mount, NFS hiccup) must not fail the import that
 * already succeeded.
 */
export async function deleteUsenetSource(opts: {
    clientType: string | null | undefined;
    /** Raw configured client root (DownloadClient.localPath, or the global download_path). */
    clientRoot: string | null | undefined;
    /** The RESOLVED path the caller read the download from — this exact path is what gets deleted. */
    sourcePath: string;
    reason: 'imported' | 'failed';
}): Promise<boolean> {
    const { clientType, clientRoot, sourcePath, reason } = opts;
    try {
        if (!clientType || !USENET_CLIENT_TYPES.includes(clientType)) return false;
        if (!clientRoot?.trim() || !sourcePath?.trim()) return false;

        // The job path must sit strictly INSIDE the client root. Rejects an empty job name
        // (path.join(root, '') === root would nuke the whole category folder) and any remote-path
        // mapping or misconfiguration that walked outside the client's own folder.
        const resolvedRoot = await resolveRemotePath(clientRoot);
        if (!isStrictSubPath(resolvedRoot, sourcePath)) {
            Logger.log(`[Usenet Cleanup] Refusing to delete "${sourcePath}" — not strictly inside client folder "${resolvedRoot}".`, 'warn');
            return false;
        }

        // Never touch library content or the watched folder, in either direction: the source must
        // not be, contain, or live inside any of them. Covers a client root misconfigured to point
        // at the library, and a library nested under the download folder.
        const libraries = await prisma.library.findMany();
        const protectedRoots = [...libraries.map(l => l.path), WATCHED_DIR].filter((p): p is string => !!p?.trim());
        for (const root of protectedRoots) {
            if (canon(root) === canon(sourcePath) || isStrictSubPath(root, sourcePath) || isStrictSubPath(sourcePath, root)) {
                Logger.log(`[Usenet Cleanup] Refusing to delete "${sourcePath}" — overlaps protected path "${root}".`, 'warn');
                return false;
            }
        }

        // Already gone (client or a script cleaned it first) — quiet no-op.
        if (!fs.existsSync(sourcePath)) return false;

        await fs.remove(sourcePath);
        Logger.log(`[Usenet Cleanup] Deleted ${reason} usenet download from client folder: ${sourcePath}`, 'info');
        return true;
    } catch (e: any) {
        Logger.log(`[Usenet Cleanup] Could not delete "${sourcePath}": ${e.message} — leaving it in place (is the download folder mounted read-only?).`, 'warn');
        return false;
    }
}
