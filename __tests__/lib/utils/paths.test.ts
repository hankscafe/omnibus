// __tests__/lib/utils/paths.test.ts
//
// The containment rules every series-folder write and every destructive folder operation leans on.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { isPathWithinRoots, isInsideLibraryRoot, librarySubfolder, folderYear } from '@/lib/utils/paths';

const slash = (p: string | null) => (p === null ? null : p.replace(/\\/g, '/'));

describe('isPathWithinRoots', () => {
    it('collapses .. before checking, and needs a separator boundary', () => {
        expect(isPathWithinRoots('/data/comics/Batman/01.cbz', ['/data/comics'])).toBe(true);
        expect(isPathWithinRoots('/data/comics/../../etc/passwd', ['/data/comics'])).toBe(false);
        expect(isPathWithinRoots('/data/comics-secret/x.cbz', ['/data/comics'])).toBe(false);
    });
});

describe('isInsideLibraryRoot', () => {
    const roots = ['/data/comics', '/data/manga/'];

    it('accepts a folder strictly inside a library root', () => {
        expect(isInsideLibraryRoot('/data/comics/Image/Saga (2012)', roots)).toBe(true);
        expect(isInsideLibraryRoot('/data/manga/Chainsaw Man', roots)).toBe(true);
        expect(isInsideLibraryRoot('/DATA/Comics/Image', roots)).toBe(true);
    });

    it('never accepts a library root itself, however it is spelled', () => {
        expect(isInsideLibraryRoot('/data/comics', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/manga', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/Image/..', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/../comics', roots)).toBe(false);
    });

    it('refuses anything that climbs out, a sibling prefix, or nothing at all', () => {
        expect(isInsideLibraryRoot('/data/comics/Image/../../config', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data', roots)).toBe(false);
        expect(isInsideLibraryRoot('/', roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics-secret/x', roots)).toBe(false);
        expect(isInsideLibraryRoot('', roots)).toBe(false);
        expect(isInsideLibraryRoot(null, roots)).toBe(false);
        expect(isInsideLibraryRoot('/data/comics/Image', [])).toBe(false);
    });
});

describe('librarySubfolder', () => {
    it('joins plain segments onto the root and drops blank ones', () => {
        expect(slash(librarySubfolder('/data/comics', 'Image/Saga (2012)'))).toBe(slash(path.join('/data/comics', 'Image', 'Saga (2012)')));
        expect(slash(librarySubfolder('/data/comics', ' Image //Saga (2012) '))).toBe(slash(path.join('/data/comics', 'Image', 'Saga (2012)')));
        expect(slash(librarySubfolder('/data/comics', 'Image\\Saga'))).toBe(slash(path.join('/data/comics', 'Image', 'Saga')));
        // Dots inside a name are fine - only a segment that IS dots can move the path.
        expect(slash(librarySubfolder('/data/comics', 'Mr. Miracle/Vol..2'))).toBe(slash(path.join('/data/comics', 'Mr. Miracle', 'Vol..2')));
    });

    it('refuses any segment that is not a plain name', () => {
        expect(librarySubfolder('/data/comics', '../comics')).toBeNull();
        expect(librarySubfolder('/data/comics', 'Image/../..')).toBeNull();
        expect(librarySubfolder('/data/comics', 'Image\\..\\..\\config')).toBeNull();
        expect(librarySubfolder('/data/comics', './Saga')).toBeNull();
        expect(librarySubfolder('/data/comics', 'Image/.../Saga')).toBeNull();
        expect(librarySubfolder('/data/comics', 'C:/Saga')).toBeNull();
    });

    it('refuses a pattern that leaves no folder (the series would BE the library root)', () => {
        expect(librarySubfolder('/data/comics', '')).toBeNull();
        expect(librarySubfolder('/data/comics', ' / / ')).toBeNull();
    });
});

describe('folderYear', () => {
    it('keeps only the digits of a positive year - the same number the Series row stores', () => {
        expect(folderYear(2012)).toBe('2012');
        expect(folderYear('2012')).toBe('2012');
        expect(folderYear(' 2012 ')).toBe('2012');
        expect(folderYear('2012/../../config')).toBe('2012');
    });

    it('gives an empty year for anything else', () => {
        for (const y of ['', '  ', 'abc', '/../..', '../2012', 0, -5, null, undefined, NaN, {}]) {
            expect(folderYear(y)).toBe('');
        }
    });
});
