// #255: an OPDS entry for a Special is titled after the Special's own volume, never as the run's "#1".
import { describe, it, expect } from 'vitest';
import { issueEntryTitle } from '@/lib/opds-feed';

describe('issueEntryTitle — a Special', () => {
    it("names a Special after its own volume, with its story title", () => {
        const special = { kind: 'SPECIAL', name: 'Absolute Batman: Ark-M' };
        expect(issueEntryTitle('Absolute Batman', { number: '1', attachedVolume: special })).toBe('Absolute Batman: Ark-M #1');
        expect(issueEntryTitle('Absolute Batman', { number: '1', name: 'A History of Arkham', attachedVolume: special })).toBe('Absolute Batman: Ark-M #1 - A History of Arkham');
    });

    it('leaves the run, annuals and other lanes as they were', () => {
        expect(issueEntryTitle('Absolute Batman', { number: '1' })).toBe('Absolute Batman #1');
        expect(issueEntryTitle('Absolute Batman', { number: '1', isAnnual: true, attachedVolume: { kind: 'ANNUAL', name: 'Absolute Batman 2025 Annual' } })).toBe('Absolute Batman Annual #1');
        expect(issueEntryTitle('Absolute Batman', { number: '1', attachedVolume: { kind: 'SPECIAL', name: '  ' } })).toBe('Absolute Batman #1');
    });
});
