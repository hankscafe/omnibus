// __tests__/lib/utils/match-prefill.test.ts
// #199 round 4 (Beta A): the matcher's "local evidence" read — series.json / Notes-id parsing are
// engine twins (scanner.rs parse_series_json / notes_issue_ids), and the merge tags every value
// with its source so the dialog can prove where data came from.
import { describe, it, expect } from 'vitest';
import { parseSeriesJson, notesIssueIds, comicInfoPrefill, folderPrefill, prefillHasContent } from '@/lib/utils/match-prefill';

describe('parseSeriesJson (engine twin)', () => {
    it('reads the Mylar-spec fields from the metadata wrapper', () => {
        const sj = parseSeriesJson(JSON.stringify({
            version: '1.0.2',
            metadata: {
                type: 'comicSeries', publisher: 'Sergio Bonelli Editore', name: 'Dylan Dog',
                comicid: 3659, year: 1986, description_text: 'Nightmare investigator.',
                booktype: 'Print', status: 'Continuing',
            },
        }));
        expect(sj).toEqual({
            comicid: 3659, name: 'Dylan Dog', publisher: 'Sergio Bonelli Editore', year: 1986,
            description: 'Nightmare investigator.', booktype: 'Print', status: 'Ongoing',
        });
    });

    it('accepts string numbers, rejects zero/invalid ids and years, normalizes Ended', () => {
        const sj = parseSeriesJson(JSON.stringify({ metadata: { comicid: '121691', year: '2019', status: 'ENDED' } }));
        expect(sj?.comicid).toBe(121691);
        expect(sj?.year).toBe(2019);
        expect(sj?.status).toBe('Ended');
        expect(parseSeriesJson(JSON.stringify({ metadata: { comicid: 0, year: 0 } }))?.comicid).toBe(null);
        expect(parseSeriesJson(JSON.stringify({ metadata: { comicid: 'abc' } }))?.comicid).toBe(null);
    });

    it('returns null for malformed or wrapper-less content', () => {
        expect(parseSeriesJson('not json')).toBe(null);
        expect(parseSeriesJson(JSON.stringify({ name: 'no wrapper' }))).toBe(null);
        expect(parseSeriesJson(JSON.stringify({ metadata: 'not an object' }))).toBe(null);
    });
});

describe('notesIssueIds (engine twin)', () => {
    it('reads the CVDB short form first', () => {
        expect(notesIssueIds('Tagged with ComicTagger [CVDB987654]')).toEqual({ cvIssueId: 987654, metronIssueId: null });
    });
    it('reads "Issue ID" as ComicVine unless Metron is named', () => {
        expect(notesIssueIds('Scraped metadata [Issue ID 123456]')).toEqual({ cvIssueId: 123456, metronIssueId: null });
        expect(notesIssueIds('Tagged from Metron [Issue ID 4242]')).toEqual({ cvIssueId: null, metronIssueId: 4242 });
    });
    it('yields nothing for untagged notes', () => {
        expect(notesIssueIds('Just a human note')).toEqual({ cvIssueId: null, metronIssueId: null });
        expect(notesIssueIds(null)).toEqual({ cvIssueId: null, metronIssueId: null });
    });
});

describe('comicInfoPrefill (loose files)', () => {
    const ci = {
        series: 'Dylan Dog', year: 1986, publisher: 'Sergio Bonelli Editore', summary: 'Horror.',
        writers: ['Tiziano Sclavi'], artists: ['Angelo Stano'], inker: [], characters: ['Dylan', 'Groucho'],
        number: '1', title: "L'alba dei morti viventi", notes: 'ComicTagger [Issue ID 111222]',
        blackAndWhite: true, cvId: null, cvIssueId: null, metronId: null, metadataIssueId: null, metadataSource: 'LOCAL',
    };

    it('maps fields to dialog keys with comicinfo provenance and joins lists', () => {
        const p = comicInfoPrefill(ci);
        expect(p.fields.name).toEqual({ value: 'Dylan Dog', source: 'comicinfo' });
        expect(p.fields.writer).toEqual({ value: 'Tiziano Sclavi', source: 'comicinfo' });
        expect(p.fields.characters?.value).toBe('Dylan, Groucho');
        expect(p.fields.inker).toBeUndefined(); // empty lists never claim a field
        expect(p.blackAndWhite).toEqual({ value: true, source: 'comicinfo' });
        expect(p.issue).toEqual({ number: '1', title: "L'alba dei morti viventi" });
    });

    it('falls back to Notes ids when the dedicated tags are absent', () => {
        expect(comicInfoPrefill(ci).ids.cvIssueId).toBe(111222);
    });

    it('prefers explicit id tags over Notes', () => {
        expect(comicInfoPrefill({ ...ci, cvIssueId: 999, cvId: 3659 }).ids).toEqual({
            cvVolumeId: 3659, cvIssueId: 999, metronSeriesId: null, metronIssueId: null,
        });
    });

    it('keeps per-file Notes out of the series-default Notes field', () => {
        expect(comicInfoPrefill(ci).fields.notes).toBeUndefined();
    });
});

describe('folderPrefill (scan row + fresh series.json)', () => {
    const row = {
        name: 'Dylan Dog', year: 1986, publisher: 'Unknown', description: null,
        writers: '["Tiziano Sclavi"]', tags: '[]', imprint: 'Bonelli', alternateCount: 3,
        blackAndWhite: true,
    };

    it('seeds from the scan-banked row and skips empties/Unknown/legacy-[]', () => {
        const p = folderPrefill(row, null);
        expect(p.fields.name).toEqual({ value: 'Dylan Dog', source: 'scan' });
        expect(p.fields.publisher).toBeUndefined(); // 'Unknown' is a placeholder, not curation
        expect(p.fields.writer).toEqual({ value: 'Tiziano Sclavi', source: 'scan' });
        expect(p.fields.tags).toBeUndefined();
        expect(p.fields.imprint?.value).toBe('Bonelli');
        expect(p.fields.alternateCount?.value).toBe('3');
        expect(p.blackAndWhite).toEqual({ value: true, source: 'scan' });
    });

    it('lets a FRESH series.json override its own fields on top of the row', () => {
        const p = folderPrefill(row, {
            comicid: 3659, name: 'Dylan Dog (New Edition)', publisher: 'SBE', year: 2019,
            description: 'Relaunch.', booktype: null, status: null,
        });
        expect(p.fields.name).toEqual({ value: 'Dylan Dog (New Edition)', source: 'series.json' });
        expect(p.fields.publisher).toEqual({ value: 'SBE', source: 'series.json' });
        expect(p.fields.year).toEqual({ value: '2019', source: 'series.json' });
        expect(p.ids.cvVolumeId).toBe(3659); // the id-assist's zero-API series match
        expect(p.fields.writer?.source).toBe('scan'); // non-series.json fields keep their origin
    });

    it('reports content honestly', () => {
        expect(prefillHasContent(folderPrefill(null, null))).toBe(false);
        expect(prefillHasContent(folderPrefill(row, null))).toBe(true);
        expect(prefillHasContent(folderPrefill(null, { comicid: 5, name: null, publisher: null, year: null, description: null, booktype: null, status: null }))).toBe(true);
    });
});
