// src/lib/utils/cover-plan.ts
// Shared cover_source policy for series covers (issue #194 follow-up).
// Node twin of the engine's resolve_cover gate (omnibus-engine/src/metadata.rs): a custom
// cover is never overwritten by provider art, and in 'archive' mode an existing local /
// extracted cover file also wins — provider art may only be downloaded when neither applies.
import fs from 'fs';
import path from 'path';

// Candidate basenames the engine probes (resolve_cover), webp included — the downloader can
// write cover.webp, so the next pass must be able to see it.
export const LOCAL_COVER_BASENAMES = [
    'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'
];

/** Basename of the first existing cover file across the candidate folders, or null. */
export function findLocalCoverBasename(...folders: Array<string | null | undefined>): string | null {
    for (const folder of folders) {
        if (!folder || !folder.trim()) continue;
        for (const basename of LOCAL_COVER_BASENAMES) {
            if (fs.existsSync(path.join(folder, basename))) return basename;
        }
    }
    return null;
}

/** True when provider art must not overwrite the folder cover. */
export function providerCoverBlocked(opts: {
    hasCustomCover: boolean;
    coverSource: string | null | undefined; // 'metadata' (default) | 'archive' | 'metadata_only'
    localCoverExists: boolean;
}): boolean {
    return opts.hasCustomCover || (opts.coverSource === 'archive' && opts.localCoverExists);
}
