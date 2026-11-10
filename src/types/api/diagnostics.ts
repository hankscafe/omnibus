// src/types/api/diagnostics.ts
//
// POST /api/admin/diagnostics {action} - the Diagnostics page's scans (each answers its own list) and
// clean-ups (each answers `{ success }`). The duplicate groups are the detector's own type.
import type { DuplicateFile, DuplicateGroup } from '@/lib/duplicate-detector';

export type { DuplicateFile, DuplicateGroup };

/** scan-ghosts: a series whose folder is gone (and nothing wants it), or an issue the engine marked MISSING. */
export interface GhostRow {
    id: string;
    type: 'SERIES' | 'ISSUE';
    name: string;
    /** 'Missing Path' for a series without one; null for an issue without a file path. */
    path: string | null;
}

/** scan-orphans: a comic file on disk that no issue row points at (minus the ignored ones). */
export interface OrphanFile {
    path: string;
    name: string;
}

/** scan-integrity: an issue whose archive the engine marked CORRUPTED. */
export interface CorruptedFile {
    id: string;
    name: string;
    path: string | null;
    error: string;
}

/** What a scan answers (one list per action), or `{ error }` with a 4xx/5xx. */
export interface DiagnosticsScanReply {
    ghosts?: GhostRow[];
    orphans?: OrphanFile[];
    corrupted?: CorruptedFile[];
    duplicates?: DuplicateGroup[];
    error?: string;
}
