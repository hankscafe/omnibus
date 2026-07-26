// src/lib/utils/alpha-buckets.ts
//
// Alphabet jump bar bucket math (Beta E, 2026-07-25 worklist item 6). Buckets are computed from
// the names index IN SERVER ORDER: offsets are first-occurrence indexes, so a jump always lands on
// a row the server will actually return at that offset — regardless of collation quirks (SQLite's
// binary collation can scatter lowercase names after 'Z'; Postgres locales group case-insensitively;
// either way the offsets stay truthful because they come from the same ordered list the pages do).

export interface LetterBucket {
    letter: string;
    /** Absolute index of the FIRST series under this letter, in server sort order. */
    offset: number;
    count: number;
}

/** The bar letter for a series name: A–Z after a light diacritic fold, everything else '#'. */
export function letterForName(name: string): string {
    const folded = (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const first = folded.trim().charAt(0).toUpperCase();
    return first >= 'A' && first <= 'Z' ? first : '#';
}

/** First-occurrence buckets over the server-ordered names index. */
export function computeLetterBuckets(names: string[]): LetterBucket[] {
    const byLetter = new Map<string, LetterBucket>();
    names.forEach((name, idx) => {
        const letter = letterForName(name);
        const existing = byLetter.get(letter);
        if (existing) {
            existing.count++;
        } else {
            byLetter.set(letter, { letter, offset: idx, count: 1 });
        }
    });
    return Array.from(byLetter.values()).sort((a, b) => a.offset - b.offset);
}
