// Who set a series' book type, and what may replace it (src/lib/book-type.ts). A stored 'Print' used to
// block every real classification for good, and the series dialog stamped 'Print' on every save.
import { describe, it, expect } from 'vitest';
import { bookTypeFromEvidence, bookTypeFromGuess, dialogBookTypePayload, dialogChoice, evidenceMayReplace } from '@/lib/book-type';

const stored = (bookType: string | null, bookTypeSource: string | null = null) => ({ bookType, bookTypeSource });

describe('evidence (a file\'s <Format>, Metron\'s series_type)', () => {
    it('fills a blank', () => {
        expect(bookTypeFromEvidence(stored(null), 'TPB', 'FILE')).toEqual({ bookType: 'TPB', bookTypeSource: 'FILE' });
        expect(bookTypeFromEvidence(stored(''), 'GN', 'METRON')).toEqual({ bookType: 'GN', bookTypeSource: 'METRON' });
    });

    it.each([null, 'GUESS', 'SERIES_JSON'])('replaces a Print nobody chose (source %s)', (source) => {
        expect(bookTypeFromEvidence(stored('Print', source), 'TPB', 'FILE')).toEqual({ bookType: 'TPB', bookTypeSource: 'FILE' });
    });

    it('never replaces the admin\'s choice, even a Print', () => {
        expect(evidenceMayReplace(stored('Print', 'ADMIN'))).toBe(false);
        expect(bookTypeFromEvidence(stored('Print', 'ADMIN'), 'TPB', 'METRON')).toEqual({});
    });

    it('leaves another source\'s evidence, and every type but Print, alone', () => {
        expect(bookTypeFromEvidence(stored('Print', 'METRON'), 'TPB', 'FILE')).toEqual({});
        expect(bookTypeFromEvidence(stored('OneShot', null), 'TPB', 'FILE')).toEqual({});
        expect(bookTypeFromEvidence(stored('TPB', 'GUESS'), 'GN', 'METRON')).toEqual({});
    });

    it('changes nothing when there is no evidence', () => {
        expect(bookTypeFromEvidence(stored(null), null, 'FILE')).toEqual({});
        expect(bookTypeFromEvidence(stored('Print'), undefined, 'METRON')).toEqual({});
    });
});

describe('the ComicVine one-shot guess', () => {
    it('only fills a blank, and says it is a guess', () => {
        expect(bookTypeFromGuess(stored(null), 'OneShot')).toEqual({ bookType: 'OneShot', bookTypeSource: 'GUESS' });
        expect(bookTypeFromGuess(stored('Print'), 'OneShot')).toEqual({});
        expect(bookTypeFromGuess(stored(null), null)).toEqual({});
    });
});

describe("the series dialog's Book Type", () => {
    it('starts on the admin\'s own type, or on Automatic for one that was detected or is blank', () => {
        expect(dialogChoice(stored('TPB', 'ADMIN'))).toBe('TPB');
        expect(dialogChoice(stored('Print', null))).toBe('AUTO');
        expect(dialogChoice(stored('GN', 'METRON'))).toBe('AUTO');
        expect(dialogChoice(stored(null))).toBe('AUTO');
    });

    it('sends nothing unless the choice changed - a save for something else leaves the type alone', () => {
        expect(dialogBookTypePayload('AUTO', stored('Print', null))).toEqual({});
        expect(dialogBookTypePayload('TPB', stored('TPB', 'ADMIN'))).toEqual({});
    });

    it('sends the chosen type, including the one that was detected (it becomes the admin\'s)', () => {
        expect(dialogBookTypePayload('Print', stored('Print', null))).toEqual({ bookType: 'Print' });
        expect(dialogBookTypePayload('GN', stored('TPB', 'ADMIN'))).toEqual({ bookType: 'GN' });
    });

    it('sends null for Automatic, handing an admin\'s type back to the files and Metron', () => {
        expect(dialogBookTypePayload('AUTO', stored('TPB', 'ADMIN'))).toEqual({ bookType: null });
    });
});
