// Collected editions dropped as loose files (#257). Real release names from a drop folder: the
// edition's name, each book's volume number, and whether a book's own name can be claimed back.
import { describe, it, expect } from 'vitest';
import {
    editionNameFromFile, bookNumberFromFile, yearFromFileName, editionNameClashesWithSeries,
    distinctEditionName, nameClaimsBook, evenCoverage, suggestIssuesPerBook, collectedFormatFromName,
    editionShelfTitle, groupCollectedShelves,
} from '@/lib/utils/collected-edition';

describe('editionNameFromFile', () => {
    it.each([
        ['Power Rangers Prime v01 (2025) (Digital) (dekabro-Empire).cbz', 'Power Rangers Prime'],
        ['Captain America Omnibus Vol. 02 (2024, 2nd edition) (digital) (TONER).cbz', 'Captain America Omnibus'],
        ['Captain America Omnibus v01 (2024, 3rd edition) (digital) (TONER).cbz', 'Captain America Omnibus'],
        ['Ghost Rider Epic Collection v04 (2026) - To Slay The Demon (digital) (Marika-Empire).cbz', 'Ghost Rider Epic Collection'],
        ['Nick Fury, Agent of S.H.I.E.L.D. Classic v01 (2012) (Digital) (Zone-Empire).cbr', 'Nick Fury, Agent of S.H.I.E.L.D. Classic'],
        ['Monsters Unleashed v02 (2018) - Learning Curve (digital) (Marika-Empire).cbz', 'Monsters Unleashed'],
        ['Saga Volume 3.cbz', 'Saga'],
    ])('%s → %s', (file, name) => {
        expect(editionNameFromFile(file)).toBe(name);
    });

    it('keeps the whole title when there is no volume token, and never reads a word starting with v as one', () => {
        expect(editionNameFromFile('Marvel Divas (2010) (digital) (Marika-Empire).cbz')).toBe('Marvel Divas');
        expect(editionNameFromFile('Venom v2 (2018).cbz')).toBe('Venom');
        expect(editionNameFromFile('Batman - The Dark Knight Returns - Deluxe Edition (2026) (digital).cbr')).toBe('Batman - The Dark Knight Returns - Deluxe Edition');
    });
});

describe('bookNumberFromFile', () => {
    it('reads the volume number, not the year, the edition number or a title digit', () => {
        expect(bookNumberFromFile('Power Rangers Prime v01 (2025) (Digital) (dekabro-Empire).cbz')).toBe('1');
        expect(bookNumberFromFile('Power Rangers Prime v04 (2026) (Digital) (dekabro-Empire).cbz')).toBe('4');
        expect(bookNumberFromFile('Captain America Omnibus Vol. 02 (2024, 2nd edition) (digital) (TONER).cbz')).toBe('2');
        expect(bookNumberFromFile('Ghost Rider Epic Collection v04 (2026) - To Slay The Demon (digital).cbz')).toBe('4');
        expect(bookNumberFromFile('Kaiju No. 8 v03 (2022).cbz')).toBe('3');
    });

    it('uses a given edition name as the hint, even one the admin renamed', () => {
        expect(bookNumberFromFile('Power Rangers Prime v02 (2025).cbz', 'Power Rangers Prime')).toBe('2');
        expect(bookNumberFromFile('Power Rangers Prime v02 (2025).cbz', 'Power Rangers Prime TPB')).toBe('2');
    });
});

describe('yearFromFileName', () => {
    it('finds the bracketed year, also when an edition note follows it', () => {
        expect(yearFromFileName('Power Rangers Prime v03 (2026) (Digital).cbz')).toBe(2026);
        expect(yearFromFileName('Captain America Omnibus v01 (2024, 3rd edition).cbz')).toBe(2024);
        expect(yearFromFileName('Saga Volume 3.cbz')).toBeNull();
    });
});

describe('edition names against the series', () => {
    it('refuses an edition named like its series, or a prefix of it', () => {
        expect(editionNameClashesWithSeries('Power Rangers Prime', 'Power Rangers Prime')).toBe(true);
        expect(editionNameClashesWithSeries('power rangers', 'Power Rangers Prime')).toBe(true);
        expect(editionNameClashesWithSeries('', 'Power Rangers Prime')).toBe(true);
        expect(editionNameClashesWithSeries('Power Rangers Prime TPB', 'Power Rangers Prime')).toBe(false);
        expect(editionNameClashesWithSeries('Captain America Omnibus', 'Captain America')).toBe(false);
    });

    it('offers a distinct name only when it has to', () => {
        expect(distinctEditionName('Power Rangers Prime', 'Power Rangers Prime')).toBe('Power Rangers Prime TPB');
        expect(distinctEditionName('Captain America Omnibus', 'Captain America')).toBe('Captain America Omnibus');
    });

    it("knows whether a book's own name is claimed back by the edition", () => {
        const file = 'Captain America Omnibus v01 (2024, 3rd edition) (digital) (TONER).cbz';
        expect(nameClaimsBook(file, 'Captain America', 'Captain America Omnibus', '1')).toBe(true);
        expect(nameClaimsBook(file, 'Captain America', 'Captain America Omnibus', '2')).toBe(false);
        // The filename carries the series' name, not the edition's: only a rename keeps it findable.
        expect(nameClaimsBook('Power Rangers Prime v01 (2025).cbz', 'Power Rangers Prime', 'Power Rangers Prime TPB', '1')).toBe(false);
        expect(nameClaimsBook('Power Rangers Prime TPB Vol. 001 (2025).cbz', 'Power Rangers Prime', 'Power Rangers Prime TPB', '1')).toBe(true);
    });
});

describe('coverage suggestions', () => {
    it('splits consecutive issues by volume number', () => {
        expect(evenCoverage('1', 4)).toBe('1-4');
        expect(evenCoverage('4', 4)).toBe('13-16');
        expect(evenCoverage('3', 1)).toBe('3');
        expect(evenCoverage('1.5', 4)).toBeNull();
        expect(evenCoverage('2', 0)).toBeNull();
    });

    it('suggests issues per book only when the run divides evenly', () => {
        expect(suggestIssuesPerBook(16, 4)).toBe(4);
        expect(suggestIssuesPerBook(16, 3)).toBeNull();
        expect(suggestIssuesPerBook(0, 4)).toBeNull();
        expect(suggestIssuesPerBook(null, 4)).toBeNull();
    });
});

// Twin of collected_format_reads_the_editions_kind_from_its_name in omnibus-engine/src/metadata_writer.rs.
describe('collectedFormatFromName', () => {
    it.each([
        ['Captain America Omnibus', 'Captain America', 'Omnibus'],
        ['Absolute Batman Omnibus', 'Absolute Batman', 'Omnibus'],
        ['Absolute Batman TPB', 'Absolute Batman', 'TPB'],
        ['Batman - The Dark Knight Returns - Deluxe Edition', 'Batman', 'HC'],
        ['Saga HC', 'Saga', 'HC'],
        ['Saga Hardcover', 'Saga', 'HC'],
        ['Absolute Sandman', 'The Sandman', 'HC'],
        ['Maus Graphic Novel', 'Maus', 'GN'],
        ['Power Rangers Prime TPB', 'Power Rangers Prime', 'TPB'],
        ['Ghost Rider Epic Collection', 'Ghost Rider', 'TPB'],
        ['Omnibusman', 'Batman', 'TPB'],
        ['Saga', 'Saga', 'TPB'],
        ['', 'Saga', 'TPB'],
    ])('%s on %s → %s', (name, series, kind) => {
        expect(collectedFormatFromName(name, series)).toBe(kind);
    });

    it('reads the whole name when the series is unknown', () => {
        expect(collectedFormatFromName('Captain America Omnibus')).toBe('Omnibus');
        expect(collectedFormatFromName('Absolute Batman TPB')).toBe('HC');
    });
});

describe('collected shelves', () => {
    it('titles a shelf by what the edition adds to the series name', () => {
        expect(editionShelfTitle('Power Rangers Prime TPB', 'Power Rangers Prime')).toBe('TPB');
        expect(editionShelfTitle('Captain America Omnibus', 'Captain America')).toBe('Omnibus');
        expect(editionShelfTitle('Ghost Rider Epic Collection', 'Ghost Rider')).toBe('Epic Collection');
        expect(editionShelfTitle('Saga: Compendium One', 'Saga')).toBe('Compendium One');
        // A provider volume named exactly like its series reads as its type.
        expect(editionShelfTitle('Saga', 'Saga')).toBe('TPB');
        expect(editionShelfTitle('Marvel Masterworks', 'Saga')).toBe('Marvel Masterworks');
    });

    it('gives every edition its own shelf: TPB, then HC, then Omnibus, then GN', () => {
        const book = (id: string, att: string | null, name: string | null) => ({ id, attachedVolumeId: att, collectionName: name });
        const shelves = groupCollectedShelves([
            book('o1', 'attO', 'Power Rangers Prime Omnibus'),
            book('t1', 'attT', 'Power Rangers Prime TPB'),
            book('t2', 'attT', 'Power Rangers Prime TPB'),
            book('h1', 'attH', 'Power Rangers Prime Deluxe Edition'),
            book('x1', null, null),
        ], 'Power Rangers Prime');
        expect(shelves.map(s => [s.title, s.format, s.books.map(b => b.id)])).toEqual([
            ['Collected Editions', 'TPB', ['x1']],
            ['TPB', 'TPB', ['t1', 't2']],
            ['Deluxe Edition', 'HC', ['h1']],
            ['Omnibus', 'Omnibus', ['o1']],
        ]);
    });
});

describe('collected shelves — a kept edition', () => {
    it("keeps a #239 kept edition's own books and the parent's rows of it on ONE shelf", () => {
        const shelves = groupCollectedShelves([
            { id: 'p1', collectionId: 'attK', attachedVolumeId: 'attK', collectionName: 'Saga Compendium' },
            { id: 'c1', collectionId: 'attK', attachedVolumeId: null, collectionName: 'Saga Compendium' },
        ], 'Saga');
        expect(shelves).toHaveLength(1);
        expect(shelves[0].books.map(b => b.id)).toEqual(['p1', 'c1']);
    });
});
