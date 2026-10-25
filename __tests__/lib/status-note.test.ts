// Request.statusNote (v1.4.10-beta.008): WHY a request is where it is - the sources a search tried, a
// stall's reason, a review's reason, an import that can't run. A note belongs to the status it was
// written with: any write that changes the status without a note of its own clears it (db.ts applies
// this to every request write), so a request that moves on never carries a stale reason.
import { describe, it, expect } from 'vitest';
import { withStatusNoteRule, plainNote } from '@/lib/status-note';

describe('statusNote rule', () => {
    it('clears the note when a write changes the status without one', () => {
        expect(withStatusNoteRule({ status: 'DOWNLOADING', progress: 0 })).toEqual({ status: 'DOWNLOADING', progress: 0, statusNote: null, statusNoteAt: null });
    });

    it('stamps a note written with its status', () => {
        const out = withStatusNoteRule({ status: 'NOT_FOUND', statusNote: 'GetComics: nothing found' });
        expect(out).toMatchObject({ status: 'NOT_FOUND', statusNote: 'GetComics: nothing found' });
        expect(out.statusNoteAt).toBeInstanceOf(Date);
    });

    it('stamps a note written on its own, and leaves the status alone', () => {
        const out = withStatusNoteRule({ statusNote: 'Downloaded, but there is no library to import into.' });
        expect(out).not.toHaveProperty('status');
        expect(out.statusNoteAt).toBeInstanceOf(Date);
    });

    it('leaves a write that touches neither alone', () => {
        expect(withStatusNoteRule({ progress: 42 })).toEqual({ progress: 42 });
        expect(withStatusNoteRule(undefined)).toBeUndefined();
    });

    it('clears the stamp with a note set to null', () => {
        expect(withStatusNoteRule({ statusNote: null })).toEqual({ statusNote: null, statusNoteAt: null });
    });
});

describe('plainNote', () => {
    it("drops the alerts' bold markers and trims", () => {
        expect(plainNote('GetComics lists **Batman #5** only on a multi-pack page. ')).toBe('GetComics lists Batman #5 only on a multi-pack page.');
    });

    it('has nothing to say for an empty reason', () => {
        expect(plainNote(undefined)).toBeNull();
        expect(plainNote('  ')).toBeNull();
    });
});
