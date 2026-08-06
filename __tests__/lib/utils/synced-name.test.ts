// __tests__/lib/utils/synced-name.test.ts
// #199 round 3: story titles must survive list syncs (Metron's issue_list only has composites),
// and the detail pass must be able to land them without file-priority fighting a placeholder.
// Twin tests: omnibus-engine/src/metadata.rs (synced_name_generic_detection /
// resolve_synced_name_protects_real_titles / detail_name_write_lands_and_respects_file_priority).
import { describe, it, expect } from 'vitest';
import { syncedNameIsGeneric, resolveSyncedName, detailNameWrite } from '@/lib/utils/synced-name';

describe('syncedNameIsGeneric', () => {
    it('flags placeholders and list composites as generic', () => {
        expect(syncedNameIsGeneric('', '154')).toBe(true);
        expect(syncedNameIsGeneric('Issue 154', '154')).toBe(true);
        // Any number — a stale placeholder is junk whatever its digits.
        expect(syncedNameIsGeneric('Issue #7', '154')).toBe(true);
        expect(syncedNameIsGeneric('#154', '154')).toBe(true);
        expect(syncedNameIsGeneric('X-Men (1991) #154', '154')).toBe(true);
        // Padding-insensitive pairing, same as isSameIssue.
        expect(syncedNameIsGeneric('X-Men (1991) #0154', '154')).toBe(true);
        // Fraction numbers count too (#200).
        expect(syncedNameIsGeneric('Wizard #½', '0.5')).toBe(true);
    });

    it('keeps real titles and story-suffixed composites non-generic', () => {
        expect(syncedNameIsGeneric('Lifedeath', '154')).toBe(false);
        expect(syncedNameIsGeneric('X-Men (1991) #154: Lifedeath', '154')).toBe(false);
        // A different trailing number is not THIS row's composite.
        expect(syncedNameIsGeneric('Uncanny X-Men #500', '154')).toBe(false);
    });
});

describe('resolveSyncedName', () => {
    const ex = 'Lifedeath';

    it('never lets a list composite clobber a real story title', () => {
        expect(resolveSyncedName(ex, 'X-Men (1991) #154', '154', false, false)).toBe(ex);
    });

    it('lets composites fill blanks and replace placeholders, and real titles win', () => {
        expect(resolveSyncedName(null, 'X-Men (1991) #154', '154', false, false)).toBe('X-Men (1991) #154');
        expect(resolveSyncedName('Issue 154', 'X-Men (1991) #154', '154', false, false)).toBe('X-Men (1991) #154');
        expect(resolveSyncedName(ex, 'Lifedeath (Part I)', '154', false, false)).toBe('Lifedeath (Part I)');
    });

    it('never blanks a name when the provider supplied nothing (issue #179)', () => {
        expect(resolveSyncedName(ex, null, '154', false, false)).toBe(ex);
        expect(resolveSyncedName(ex, '  ', '154', false, false)).toBe(ex);
    });

    it('lock and file-priority outrank everything', () => {
        expect(resolveSyncedName(ex, 'Provider', '154', true, false)).toBe(ex);
        expect(resolveSyncedName(ex, 'Provider', '154', false, true)).toBe(ex);
    });
});

describe('detailNameWrite', () => {
    it('lands the story title over blanks, placeholders, and composites', () => {
        expect(detailNameWrite(null, 'Lifedeath', '154', false)).toBe('Lifedeath');
        expect(detailNameWrite('Issue 154', 'Lifedeath', '154', false)).toBe('Lifedeath');
        expect(detailNameWrite('X-Men (1991) #154', 'Lifedeath', '154', false)).toBe('Lifedeath');
    });

    it('file priority protects only a REAL existing title, not a placeholder', () => {
        expect(detailNameWrite('From ComicInfo', 'Lifedeath', '154', true)).toBe(null);
        expect(detailNameWrite('Issue 154', 'Lifedeath', '154', true)).toBe('Lifedeath');
    });

    it('leaves the column alone when the detail carried no real title', () => {
        expect(detailNameWrite('Lifedeath', null, '154', false)).toBe(null);
        expect(detailNameWrite('Lifedeath', '   ', '154', false)).toBe(null);
    });
});
