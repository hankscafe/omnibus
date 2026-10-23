// Naming parity: src/lib/utils/naming.ts and the engine's naming.rs read the same table of cases
// (omnibus-engine/tests/fixtures/naming_parity.json), so a file gets the same name whichever door
// it comes through - an import, the Smart Matcher, the watched folder, Standardize.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { padIssue, issuePaddingFromSetting, issueYear, issueFileName, seriesFolderSegments, sanitizeNamingPart } from '@/lib/utils/naming';
import { filePatternForIssue } from '@/lib/utils/file-pattern';

const parity = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'omnibus-engine', 'tests', 'fixtures', 'naming_parity.json'), 'utf8'));

describe('naming parity with the engine', () => {
    it.each(parity.padIssue as [string, string, string][])('pads %j at %j as %j', (number, padding, expected) => {
        expect(padIssue(number, issuePaddingFromSetting(padding))).toBe(expected);
    });

    it.each(parity.issueYear as any[])('issue year of $releaseDate / $comicInfoYear / $seriesYear is $expected', (c) => {
        expect(issueYear(c.releaseDate, c.comicInfoYear, c.seriesYear)).toBe(c.expected);
    });

    it.each(parity.files as any[])('file: $label', (c) => {
        expect(issueFileName(c.pattern, c.input, issuePaddingFromSetting(c.padding))).toBe(c.expected);
    });

    it.each(parity.folders as any[])('folder: $label', (c) => {
        expect(seriesFolderSegments(c.pattern, c.input)).toEqual(c.expected);
    });

    // Which template one issue gets — the engine's renamer.rs file_pattern_for_issue reads the same rows.
    it.each(parity.patternChoice as any[])('pattern: $label', (c) => {
        expect(filePatternForIssue({
            isAnnual: c.annual, isCollected: c.collected, isRetainedCollected: c.retainedCollected, isManga: c.manga,
            filePattern: c.filePattern, mangaFilePattern: c.mangaFilePattern, collectedFilePattern: c.collectedFilePattern,
        })).toBe(c.expected);
    });
});

describe('naming helpers', () => {
    it('reads the padding setting, defaulting to three digits', () => {
        expect(issuePaddingFromSetting(undefined)).toBe('3');
        expect(issuePaddingFromSetting('')).toBe('3');
        expect(issuePaddingFromSetting('4')).toBe('3');
        expect(issuePaddingFromSetting(' 2 ')).toBe('2');
        expect(issuePaddingFromSetting('none')).toBe('none');
    });

    it('sanitizes one component and neutralizes dot-only traversal', () => {
        expect(sanitizeNamingPart(' Absolute/ Batman ')).toBe('Absolute Batman');
        expect(sanitizeNamingPart('..')).toBe('_');
        expect(sanitizeNamingPart('')).toBe('');
        expect(sanitizeNamingPart(null)).toBe('');
    });

    it('never treats a token name as an object property', () => {
        expect(issueFileName('{Series} {constructor} {toString} #{Issue}', { series: 'Batman', issueNumber: '1' }, '3')).toBe('Batman {constructor} {toString} #001');
    });
});
