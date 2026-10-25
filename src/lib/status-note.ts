// src/lib/status-note.ts
//
// Request.statusNote: WHY a request is where it is, shown to admins in Request Management - the
// sources a search tried (NOT_FOUND), a stall's reason, a review's reason, an import that can't run.
//
// A note belongs to the status it was written with. db.ts runs every request write through
// withStatusNoteRule: a write that changes the status without a note of its own clears it, so a
// request that moves on (a new search, a download, an import, a cancel) never carries a stale reason,
// and no write site has to remember to clear it. Kept free of imports: db.ts depends on it.

/** What a NOT_FOUND request says when the engine sent no per-source summary (an older engine). */
export const NOT_FOUND_FALLBACK_NOTE = 'Searched every enabled source; none had it.';

type WithNote<T> = T & { statusNote?: string | null; statusNoteAt?: Date | null };

export function withStatusNoteRule<T>(data: T): WithNote<T> {
    if (!data || typeof data !== 'object') return data as WithNote<T>;
    const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    if ('status' in out && !('statusNote' in out)) {
        out.statusNote = null;
        out.statusNoteAt = null;
    } else if ('statusNote' in out && !('statusNoteAt' in out)) {
        out.statusNoteAt = out.statusNote == null ? null : new Date();
    }
    return out as WithNote<T>;
}

/** A reason written for an alert (Markdown bold for Discord) as a plain note; null when there is none. */
export function plainNote(text: string | null | undefined): string | null {
    const plain = (text ?? '').replace(/\*\*/g, '').trim();
    return plain ? plain : null;
}
