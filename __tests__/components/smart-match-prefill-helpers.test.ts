// __tests__/components/smart-match-prefill-helpers.test.ts
// #199 round 4 (Beta A): the dialog-side halves of the file-first contract — seeding precedence
// (admin override > the library's files > provider suggestion) and the provider gap-fill plan
// (empty fields only, mathematically incapable of overwriting curation).
import { describe, it, expect } from 'vitest';
import { seedValue, providerFillPlan } from '@/components/smart-match-metadata-dialog';
import { acceptableForBulk, nameSimilarity, yearTerm, seriesQueryFromName, rankSearchResults, pickSuggestion } from '@/lib/utils/smart-match-search';

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

// ==== Suggestion ranking (robotshavehearts2): the auto-scan stops taking results[0]. ====

describe('nameSimilarity — exact twin of matcher.rs name_similarity', () => {
    it('reproduces the engine test cases token for token', () => {
        expect(nameSimilarity('Wolverine', 'wolverine')).toBe(1);
        // The slash-title report from discussion #177: symbols fold to spaces.
        expect(nameSimilarity('Hack/Slash', 'Hack Slash')).toBe(1);
        expect(nameSimilarity('Batman & Robin', 'Batman Robin')).toBe(1);
        // A prefixed sibling scores well under 1.0 (2 common of 1+2 tokens = 0.666…).
        const sib = nameSimilarity('Wolverine', 'Savage Wolverine');
        expect(sib).toBeGreaterThan(0.6);
        expect(sib).toBeLessThan(0.7);
        expect(nameSimilarity('Batman', 'Superman')).toBe(0);
        expect(nameSimilarity('', 'Batman')).toBe(0);
    });
});

describe('yearTerm — a tiebreaker-plus, never a sort key', () => {
    it('rewards agreement modestly, tolerates off-by-one, penalises far years, ignores unknowns', () => {
        expect(yearTerm(2024, 2024)).toBe(0.10);
        expect(yearTerm(2023, 2024)).toBe(0.05);
        expect(yearTerm(2016, 2011)).toBe(-0.05);
        expect(yearTerm(null, 2024)).toBe(0);
        expect(yearTerm(2024, null)).toBe(0);
        expect(yearTerm(0, 2024)).toBe(0);
    });
});

describe('seriesQueryFromName — what the auto-scan actually searches for', () => {
    it('strips a raw file down to its series, keeping the year for the ranker only', () => {
        // The unmatched list hands a loose file over as its filename minus extension.
        expect(seriesQueryFromName('X-Men 001 (2024)')).toEqual({ query: 'X-Men', year: 2024 });
        expect(seriesQueryFromName('Batman #12')).toEqual({ query: 'Batman', year: null });
        expect(seriesQueryFromName('Saga v01')).toEqual({ query: 'Saga', year: null });
        expect(seriesQueryFromName('The Walking Dead 012.5 [2004]')).toEqual({ query: 'The Walking Dead', year: 2004 });
    });

    it('strips edition words anywhere, as whole words, without eating real titles', () => {
        expect(seriesQueryFromName('Batman Omnibus Vol. 2')).toEqual({ query: 'Batman', year: null });
        expect(seriesQueryFromName('Saga Compendium One TPB')).toEqual({ query: 'Saga One', year: null });
        // Only a TRAILING number is an issue token — a number inside the title is the title.
        expect(seriesQueryFromName('Kaiju No. 8 003')).toEqual({ query: 'Kaiju No. 8', year: null });
        // Whole words only: the old unbounded regex would have matched "vol" inside a word.
        expect(seriesQueryFromName('Revolver')).toEqual({ query: 'Revolver', year: null });
    });

    it('never searches for nothing', () => {
        expect(seriesQueryFromName('Omnibus').query).toBe('Omnibus');
    });
});

describe('rankSearchResults / pickSuggestion — the name dominates unless names tie', () => {
    const cv = (id: number, name: string, year: number | null) => ({ id, name, year });

    it("no longer pulls every same-year volume ahead of the exact name (the field report's case)", () => {
        // The old boolean year sort put ALL 2024 volumes first, in CV's order — [0] was a coin flip.
        const results = [
            cv(1, 'X-Men: From the Ashes Infinity Comic', 2024),
            cv(2, 'X-Men Annual', 2024),
            cv(3, 'X-Men', 2024),
            cv(4, 'X-Men', 1991),
        ];
        const ranked = rankSearchResults('X-Men', 2024, results);
        // Scores: X-Men (2024) 1.10 · X-Men (1991) 0.95 · X-Men Annual (2024) 0.90 · Infinity 0.54.
        expect(ranked[0].result.id).toBe(3);   // exact name AND year
        // The exact name with a far-off year still outranks the same-year near-miss: the year's
        // whole reach (0.15) is smaller than a one-token name gap on a two-token name (0.2).
        expect(ranked[1].result.id).toBe(4);
        expect(ranked[2].result.id).toBe(2);
        expect(pickSuggestion('X-Men', 2024, results)?.id).toBe(3);
    });

    it('lets a correct name survive a wrong folder year', () => {
        // Folder says 2014; the right volume is Batman (2011). The same-year wrong name scores
        // 0.667 + 0.10 = 0.767; either exact name scores 1.0 − 0.05 = 0.95 — the name wins.
        const results = [cv(1, 'Batman Eternal', 2014), cv(2, 'Batman', 2011), cv(3, 'Batman', 2016)];
        expect(pickSuggestion('Batman', 2014, results)?.id).not.toBe(1);
        // Between the two exact names the year is the tiebreaker: with the folder saying 2012,
        // Batman (2011) is off by one (+0.05) and Batman (2016) is far (−0.05).
        expect(pickSuggestion('Batman', 2012, results)?.id).toBe(2);
        // With 2014 both exact names are equally far (−0.05 each) — a genuine tie, which keeps the
        // provider's order rather than inventing a preference. The engine's pick_best does the same.
        expect(pickSuggestion('Batman', 2014, results)?.id).toBe(2);
    });

    it('prefers the plain series over its annual when both share the year', () => {
        expect(pickSuggestion('Batman', 2012, [cv(1, 'Batman Annual', 2012), cv(2, 'Batman', 2012)])?.id).toBe(2);
    });

    it('reports nothing rather than a wild guess, so Accept All cannot sweep it up', () => {
        expect(pickSuggestion('Kaiju No. 8', 2023, [cv(1, 'Amazing Spider-Man', 2018), cv(2, 'Uncanny X-Men', 1981)])).toBeNull();
        expect(pickSuggestion('Anything', null, [])).toBeNull();
        // Half the tokens in common is the floor.
        expect(pickSuggestion('Savage Wolverine', null, [cv(1, 'Wolverine', 2013)])?.id).toBe(1);
    });

    it('treats an unknown year as neutral on both sides', () => {
        const results = [cv(1, 'Saga', null), cv(2, 'Saga: Compendium', 2019)];
        expect(pickSuggestion('Saga', null, results)?.id).toBe(1);
        expect(rankSearchResults('Saga', 2012, results)[0].yearTerm).toBe(0);
    });
});
