// __tests__/components/smart-match-prefill-helpers.test.ts
// #199 round 4 (Beta A): the dialog-side halves of the file-first contract — seeding precedence
// (admin override > the library's files > provider suggestion) and the provider gap-fill plan
// (empty fields only, mathematically incapable of overwriting curation).
import { describe, it, expect } from 'vitest';
import { seedValue, providerFillPlan } from '@/components/smart-match-metadata-dialog';
import { acceptableForBulk } from '@/lib/utils/smart-match-search';

describe('seedValue', () => {
    const filePrefill = { value: 'Dylan Dog', source: 'comicinfo' };

    it('lets a saved admin override outrank everything', () => {
        expect(seedValue('My Name', filePrefill, 'Provider Name')).toBe('My Name');
    });
    it('lets the files outrank the provider suggestion', () => {
        expect(seedValue(undefined, filePrefill, 'Provider Name')).toBe('Dylan Dog');
    });
    it('lets the provider fill only what nothing else claimed', () => {
        expect(seedValue(undefined, undefined, 'Provider Name')).toBe('Provider Name');
        expect(seedValue('', undefined, 'Provider Name')).toBe('Provider Name');
    });
    it('yields empty when no source has a value', () => {
        expect(seedValue(undefined, undefined, undefined)).toBe('');
        expect(seedValue('   ', undefined, null)).toBe('');
    });
});

describe('providerFillPlan', () => {
    it('fills only empty fields — existing values are never in the plan', () => {
        const plan = providerFillPlan(
            { writer: 'Tiziano Sclavi', penciller: '', colorist: undefined },
            { writer: 'Provider Writer', penciller: 'Angelo Stano', colorist: 'Some Colorist' },
        );
        expect(plan).toEqual({ penciller: 'Angelo Stano', colorist: 'Some Colorist' });
    });
    it('ignores empty provider values and yields an empty plan when there is nothing to add', () => {
        expect(providerFillPlan({ writer: 'Kept' }, { writer: 'X', penciller: '  ' })).toEqual({});
        expect(providerFillPlan({}, undefined)).toEqual({});
    });
});

describe('acceptableForBulk — Accept All candidates (ignore state)', () => {
    const suggestions = { a: { id: '1' }, b: 'NOT_FOUND', c: 'ERROR', d: { id: '2' } };

    it('takes only rows with a real suggestion', () => {
        const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'e' }];
        expect(acceptableForBulk(items, suggestions).map(i => i.id)).toEqual(['a']);
    });

    it('never includes an ignored row, even when it has a good suggestion', () => {
        // The "Show ignored" toggle puts these on screen; a bulk accept must not undo the decision.
        const items = [{ id: 'a' }, { id: 'd', isIgnored: true }];
        expect(acceptableForBulk(items, suggestions).map(i => i.id)).toEqual(['a']);
    });
});
