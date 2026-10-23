// Which naming template an issue gets — the Node half of a twin pair. The engine's
// renamer.rs `file_pattern_for_issue` must answer identically, and the rename PREVIEW must agree
// with both: a preview that promises a name the renamer doesn't produce is a bug that already
// shipped once (annuals, caught in the beta.007 walk).
import { describe, it, expect } from 'vitest';
import { filePatternForIssue, namingAttachment, seriesTokenForIssue, ANNUAL_FILE_PATTERN, COLLECTED_FILE_PATTERN } from '@/lib/utils/file-pattern';

const comic = '{Series} #{Issue}';
const manga = '{Series} Vol. {Issue}';

describe('filePatternForIssue', () => {
    it('gives a plain issue the comic pattern, and a manga issue the manga one', () => {
        expect(filePatternForIssue({ filePattern: comic, mangaFilePattern: manga })).toBe(comic);
        expect(filePatternForIssue({ isManga: true, filePattern: comic, mangaFilePattern: manga })).toBe(manga);
        // A blank manga template is not a template — fall back rather than emit empty names.
        expect(filePatternForIssue({ isManga: true, filePattern: comic, mangaFilePattern: '  ' })).toBe(comic);
    });

    it('gives an annual the fixed Mylar shape, outranking the manga template', () => {
        expect(filePatternForIssue({ isAnnual: true, filePattern: comic, mangaFilePattern: manga })).toBe(ANNUAL_FILE_PATTERN);
        expect(filePatternForIssue({ isAnnual: true, isManga: true, filePattern: comic, mangaFilePattern: manga })).toBe(ANNUAL_FILE_PATTERN);
    });

    it('gives a collected edition its configurable pattern, outranking everything', () => {
        // Unset → the built-in default.
        expect(filePatternForIssue({ isCollected: true, filePattern: comic, mangaFilePattern: manga })).toBe(COLLECTED_FILE_PATTERN);
        // Configured → the admin's choice wins, for manga series too.
        expect(filePatternForIssue({
            isCollected: true, isManga: true, filePattern: comic, mangaFilePattern: manga, collectedFilePattern: '{Series} v{Issue}',
        })).toBe('{Series} v{Issue}');
        // Blank setting falls back to the default, never to an empty name.
        expect(filePatternForIssue({ isCollected: true, filePattern: comic, collectedFilePattern: '   ' })).toBe(COLLECTED_FILE_PATTERN);
        // Collected beats annual when a row is somehow both: the attachment's kind is an explicit
        // human decision about what the file IS.
        expect(filePatternForIssue({ isCollected: true, isAnnual: true, filePattern: comic })).toBe(COLLECTED_FILE_PATTERN);
    });

    it('matches the engine constants exactly (twin drift guard)', () => {
        expect(ANNUAL_FILE_PATTERN).toBe('{Series} Annual #{Issue} ({IssueYear})');
        expect(COLLECTED_FILE_PATTERN).toBe('{Series} Vol. {Issue} ({IssueYear})');
    });
});

// A LOCAL collected edition (one the provider has no volume for) is claimed by its files' NAMES
// alone — the beta.018 name rule — so its books must be named after the edition, not the parent
// series: "Batman Compendium Vol. 001", never "Batman Vol. 001", or the next wipe orphans them
// (and the file parses as run #1). Twin: renamer.rs `series_token_for_issue`.
describe('seriesTokenForIssue', () => {
    it('names a LOCAL collected book after its edition', () => {
        expect(seriesTokenForIssue({
            isCollected: true, attachmentSource: 'LOCAL', attachmentName: 'Batman Compendium', seriesName: 'Batman',
        })).toBe('Batman Compendium');
        // Trimmed, so a padded name never leaks whitespace into the filename.
        expect(seriesTokenForIssue({
            isCollected: true, attachmentSource: 'LOCAL', attachmentName: '  Batman Compendium ', seriesName: 'Batman',
        })).toBe('Batman Compendium');
    });

    it('keeps the series name for provider-backed books, whose claim is the issue id', () => {
        expect(seriesTokenForIssue({
            isCollected: true, attachmentSource: 'COMICVINE', attachmentName: 'Batman: The Deluxe Edition', seriesName: 'Batman',
        })).toBe('Batman');
        expect(seriesTokenForIssue({
            isCollected: true, attachmentSource: 'METRON', attachmentName: 'Batman TPB', seriesName: 'Batman',
        })).toBe('Batman');
    });

    it('keeps the series name when there is nothing to name after, or the row is not a collected book', () => {
        // A blank edition name is not a name.
        expect(seriesTokenForIssue({ isCollected: true, attachmentSource: 'LOCAL', attachmentName: '  ', seriesName: 'Batman' })).toBe('Batman');
        expect(seriesTokenForIssue({ isCollected: true, attachmentSource: 'LOCAL', attachmentName: null, seriesName: 'Batman' })).toBe('Batman');
        // Only collected books take the edition's name; a plain issue or an annual never does.
        expect(seriesTokenForIssue({ isCollected: false, attachmentSource: 'LOCAL', attachmentName: 'Batman Compendium', seriesName: 'Batman' })).toBe('Batman');
        expect(seriesTokenForIssue({ seriesName: 'Batman' })).toBe('Batman');
    });
});

// #239: a series a COLLECTED attachment keeps as its own ("Leave it as its own series").
describe('a kept-as-its-own collection', () => {
    it('names its books as collected editions, after an annual and over manga', () => {
        expect(filePatternForIssue({ isRetainedCollected: true, filePattern: comic })).toBe(COLLECTED_FILE_PATTERN);
        expect(filePatternForIssue({ isRetainedCollected: true, filePattern: comic, collectedFilePattern: '{Series} v{Issue}' })).toBe('{Series} v{Issue}');
        expect(filePatternForIssue({ isRetainedCollected: true, isManga: true, filePattern: comic, mangaFilePattern: manga })).toBe(COLLECTED_FILE_PATTERN);
        expect(filePatternForIssue({ isRetainedCollected: true, isAnnual: true, filePattern: comic })).toBe(ANNUAL_FILE_PATTERN);
    });

    it("takes an issue's attachment only when it is the issue's own series'", () => {
        const own = { kind: 'COLLECTED', seriesId: 'parent' };
        expect(namingAttachment({ seriesId: 'parent', attachedVolume: own })).toBe(own);
        // A row that strayed into the child still carrying the parent's attachment id.
        expect(namingAttachment({ seriesId: 'child', attachedVolume: own })).toBeNull();
        expect(namingAttachment({ seriesId: 'parent', attachedVolume: null })).toBeNull();
    });
});
