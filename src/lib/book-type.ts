// Who set a series' book type (Series.bookTypeSource), and what may replace it. A stored 'Print' used
// to block every real classification for good: each automatic source only filled a blank, and two
// paths stamped 'Print' that nobody chose (the series dialog defaulted to it on every save, and older
// scans read our own guessed series.json export back in). Twin of omnibus-engine/src/book_type.rs.
//   ADMIN        chosen in the series dialog - never replaced.
//   FILE, METRON evidence (a file's <Format>, Metron's series_type): fills a blank, and replaces a
//                Print nobody chose - one with no source (set before sources were recorded) or one
//                only a guess or a series.json read-back put there.
//   GUESS        the ComicVine one-shot heuristic; SERIES_JSON a value read back from series.json:
//                these only fill a blank.

export const BOOK_TYPES = ['Print', 'OneShot', 'TPB', 'GN'] as const;
export type BookType = (typeof BOOK_TYPES)[number];
export type BookTypeSource = 'ADMIN' | 'FILE' | 'METRON' | 'GUESS' | 'SERIES_JSON';

type Stored = { bookType: string | null; bookTypeSource?: string | null };

const WEAK_SOURCES: (string | null)[] = [null, 'GUESS', 'SERIES_JSON'];

/** May evidence (FILE, METRON) write over what is stored? */
export function evidenceMayReplace(stored: Stored): boolean {
    if (!stored.bookType) return true;
    return stored.bookType === 'Print' && WEAK_SOURCES.includes(stored.bookTypeSource || null);
}

/** The update for a value a file or Metron reports; empty when it doesn't apply. */
export function bookTypeFromEvidence(stored: Stored, value: string | null | undefined, source: 'FILE' | 'METRON') {
    if (!value || !evidenceMayReplace(stored)) return {};
    return { bookType: value, bookTypeSource: source };
}

/** The update for the ComicVine one-shot guess: a blank only. */
export function bookTypeFromGuess(stored: Stored, value: string | null | undefined) {
    if (!value || stored.bookType) return {};
    return { bookType: value, bookTypeSource: 'GUESS' as const };
}

/**
 * The series dialog's starting choice: the admin's own type, or 'AUTO' ("Automatic") for one that was
 * detected or is blank. Re-choosing a detected type is then a change, which makes it the admin's.
 */
export function dialogChoice(stored: Stored): string {
    return stored.bookTypeSource === 'ADMIN' && stored.bookType ? stored.bookType : 'AUTO';
}

/**
 * What the dialog sends to /api/library/update: nothing unless the choice changed - a save made for
 * something else (a monitor toggle, a year fix) must not touch the type - and null for "Automatic",
 * which hands the type back to the files and Metron.
 */
export function dialogBookTypePayload(choice: string, stored: Stored): { bookType?: string | null } {
    if (choice === dialogChoice(stored)) return {};
    return { bookType: choice === 'AUTO' ? null : choice };
}
