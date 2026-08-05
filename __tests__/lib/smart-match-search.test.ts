// __tests__/lib/smart-match-search.test.ts
//
// Search Match (#199 round 2, concept by CapitanoNemo78): search-by-name is the primary
// manual-match flow, the exact-ID lookup stays as the advanced fallback. Both paths resolve
// through the same helpers pinned here — the ID sanitizer is the fallback's contract, and the
// number normalization + cross-reference drive the Issue Mapping auto-fill for BOTH flows.
import { describe, it, expect } from 'vitest';
import {
    buildManualSuggestion, cleanProviderId, findIssueIdByNumber, normalizeIssueNumber,
} from '../../src/lib/utils/smart-match-search';

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
