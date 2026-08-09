// __tests__/lib/smart-match-search.test.ts
//
// Search Match (#199 round 2, concept by CapitanoNemo78): search-by-name is the primary
// manual-match flow, the exact-ID lookup stays as the advanced fallback. Both paths resolve
// through the same helpers pinned here — the ID sanitizer is the fallback's contract, and the
// number normalization + cross-reference drive the Issue Mapping auto-fill for BOTH flows.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    buildKeepCarry, buildManualSuggestion, cleanProviderId, findIssueIdByNumber, normalizeIssueNumber,
    resolveIssueIdByNumber,
} from '../../src/lib/utils/smart-match-search';

// #199 round 4 Beta B: keep-mode's silent carry — the files' CONTENT fields land and lock at
// Accept even when the admin never opened the editor. Identity (name/year/publisher) stays with
// the chosen match; an empty prefill changes nothing at all.
describe('buildKeepCarry', () => {
    it('carries content fields + the lock, never identity', () => {
        const carry = buildKeepCarry({
            fields: {
                name: { value: 'Dylan Dog', source: 'series.json' },      // identity — must NOT carry
                year: { value: '1986', source: 'series.json' },           // identity — must NOT carry
                description: { value: 'Curated.', source: 'series.json' },
                writer: { value: 'Tiziano Sclavi', source: 'comicinfo' },
                imprint: { value: 'Bonelli', source: 'scan' },
            },
            blackAndWhite: { value: true, source: 'comicinfo' },
        });
        expect(carry).toEqual({
            description: 'Curated.', writer: 'Tiziano Sclavi', imprint: 'Bonelli',
            blackAndWhite: true, lockMetadata: true,
        });
    });

    it('returns null (no payload change, no lock) when the files supplied nothing carryable', () => {
        expect(buildKeepCarry(null)).toBe(null);
        expect(buildKeepCarry({ fields: {} })).toBe(null);
        expect(buildKeepCarry({ fields: { name: { value: 'Identity Only', source: 'scan' } } })).toBe(null);
    });
});

describe('cleanProviderId', () => {
    it('strips the ComicVine 4050- prefix', () => {
        expect(cleanProviderId('4050-12345')).toBe('12345');
    });
    it('keeps Metron slugs intact', () => {
        expect(cleanProviderId('dragonero-2013')).toBe('dragonero-2013');
    });
    it('drops pasted junk (whitespace, URL leftovers)', () => {
        expect(cleanProviderId(' 4050-12345/ ')).toBe('12345');
        expect(cleanProviderId('')).toBe('');
    });
});

describe('normalizeIssueNumber', () => {
    it('treats leading zeros as presentation, not identity', () => {
        expect(normalizeIssueNumber('049')).toBe('49');
        expect(normalizeIssueNumber('49')).toBe('49');
    });
    it('keeps a bare zero and non-numeric tails', () => {
        expect(normalizeIssueNumber('0')).toBe('0');
        expect(normalizeIssueNumber('12.5')).toBe('12.5');
    });
    it('handles null/undefined/number inputs', () => {
        expect(normalizeIssueNumber(null)).toBe('');
        expect(normalizeIssueNumber(undefined)).toBe('');
        expect(normalizeIssueNumber(7)).toBe('7');
    });
});

describe('findIssueIdByNumber', () => {
    const stubs = [
        { id: 900, issue_number: '001', name: 'A #1' },
        { id: 901, issue_number: '011', name: 'A #11' },
        { id: 902, number: '12', name: 'A #12' }, // generic `number` fallback field
    ];
    it('cross-references zero-padded stubs against an unpadded extraction', () => {
        expect(findIssueIdByNumber(stubs, '11')).toBe('901');
        expect(findIssueIdByNumber(stubs, '1')).toBe('900');
    });
    it('reads the generic number field when issue_number is absent', () => {
        expect(findIssueIdByNumber(stubs, '12')).toBe('902');
    });
    it('returns empty for no match, empty input, or missing list', () => {
        expect(findIssueIdByNumber(stubs, '99')).toBe('');
        expect(findIssueIdByNumber(stubs, '')).toBe('');
        expect(findIssueIdByNumber(undefined, '11')).toBe('');
    });
});

describe('buildManualSuggestion', () => {
    const payload = {
        id: 16180, name: 'Conan & Dragonero', year: '2026', publisher: 'SBE',
        image: '/api/library/cover?path=x', description: 'crossover',
        count: 5, issues: [{ id: '171893', issue_number: '1', name: 'Conan & Dragonero #1' }],
    };
    it('carries the volume identity, provider, and raw issue stubs', () => {
        const s = buildManualSuggestion(payload, 'METRON');
        expect(s).toMatchObject({ id: 16180, name: 'Conan & Dragonero', metadataSource: 'METRON', count: 5 });
        expect(s.rawIssues).toHaveLength(1);
    });
    it('falls back through the issue-count chain, ending at the stub count then "?"', () => {
        expect(buildManualSuggestion({ ...payload, count: 0 }, 'METRON').count).toBe(1); // issues.length
        expect(buildManualSuggestion({ ...payload, count: 0, issues: [] }, 'METRON').count).toBe('?');
        expect(buildManualSuggestion({ ...payload, count: 0, count_of_issues: 78 }, 'METRON').count).toBe(78);
    });
    it('prefers id but accepts volumeId payloads', () => {
        expect(buildManualSuggestion({ ...payload, id: undefined, volumeId: 42 }, 'COMICVINE').id).toBe(42);
    });
});

describe('resolveIssueIdByNumber (#199 round 2: right series, wrong issue)', () => {
    afterEach(() => vi.unstubAllGlobals());
    const stubs = [
        { id: '171893', issue_number: '1', name: 'A #1' },
        { id: '171947', issue_number: '154', name: 'A #154' },
    ];

    it('treats a non-empty rawIssues list as authoritative — hit or miss, no fetch', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await expect(resolveIssueIdByNumber({ issueNumber: '154', rawIssues: stubs })).resolves.toBe('171947');
        await expect(resolveIssueIdByNumber({ issueNumber: '99', rawIssues: stubs, seriesMetadataId: 16180 })).resolves.toBe('');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls back to one volume-details fetch when no list is at hand', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ issues: stubs }) });
        vi.stubGlobal('fetch', fetchSpy);
        await expect(resolveIssueIdByNumber({
            issueNumber: '154', rawIssues: [], seriesMetadataId: 16180, provider: 'METRON',
        })).resolves.toBe('171947');
        expect(fetchSpy).toHaveBeenCalledWith('/api/issue-details?id=16180&type=volume&provider=METRON');
    });

    it('returns empty without fetching when there is no series id to look up', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await expect(resolveIssueIdByNumber({ issueNumber: '5' })).resolves.toBe('');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('surfaces a fallback-fetch failure as a throw (callers toast it)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'metron 429' }) }));
        await expect(resolveIssueIdByNumber({ issueNumber: '5', seriesMetadataId: 1 })).rejects.toThrow('metron 429');
    });
});
