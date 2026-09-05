// Which naming template an issue gets — the Node half of a twin pair. The engine's
// renamer.rs `file_pattern_for_issue` must answer identically, and the rename PREVIEW must agree
// with both: a preview that promises a name the renamer doesn't produce is a bug that already
// shipped once (annuals, caught in the beta.007 walk).
import { describe, it, expect } from 'vitest';
import { filePatternForIssue, ANNUAL_FILE_PATTERN, COLLECTED_FILE_PATTERN } from '@/lib/utils/file-pattern';

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
