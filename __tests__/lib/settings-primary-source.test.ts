// __tests__/lib/settings-primary-source.test.ts
//
// The settings page moves the primary metadata source to the other provider when the chosen one
// loses its credentials (a cleared ComicVine key, a removed Metron token) and the other one has
// them. The decision used to live inline in a page effect that read the whole config without
// listing it as a dependency (an exhaustive-deps warning); it is now a pure function the effect
// keys on. These pin the decision exactly as the inline version made it.
import { describe, it, expect } from 'vitest';
import { primarySourceFallback } from '@/app/admin/settings/tabs/primary-source';

describe('primarySourceFallback', () => {
    it('moves Metron to ComicVine when Metron has no credentials and ComicVine has a key', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'METRON', cv_api_key: 'abc' })).toBe('COMICVINE');
    });

    it('moves ComicVine to Metron when the key is gone and Metron has a token', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE', cv_api_key: '', metron_api_token: 'tok' })).toBe('METRON');
    });

    it('a Metron username and password count as Metron credentials', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE', metron_user: 'adam', metron_pass: 'pw' })).toBe('METRON');
        // A username without a password is not a setup.
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE', metron_user: 'adam', metron_pass: '' })).toBeNull();
    });

    it('a whitespace-only ComicVine key counts as no key', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE', cv_api_key: '   ', metron_api_token: 'tok' })).toBe('METRON');
        expect(primarySourceFallback({ primary_metadata_source: 'METRON', cv_api_key: '   ' })).toBeNull();
    });

    it('a masked saved secret counts as set, so nothing moves', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE', cv_api_key: '********', metron_api_token: 'tok' })).toBeNull();
        expect(primarySourceFallback({ primary_metadata_source: 'METRON', metron_api_token: '********', cv_api_key: 'abc' })).toBeNull();
    });

    it('leaves a source that still has its credentials alone', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE', cv_api_key: 'abc', metron_api_token: 'tok' })).toBeNull();
        expect(primarySourceFallback({ primary_metadata_source: 'METRON', cv_api_key: 'abc', metron_api_token: 'tok' })).toBeNull();
    });

    it('stays put when neither provider has credentials', () => {
        expect(primarySourceFallback({ primary_metadata_source: 'COMICVINE' })).toBeNull();
        expect(primarySourceFallback({ primary_metadata_source: 'METRON', cv_api_key: '' })).toBeNull();
    });

    it('an unset or unknown primary source is never rewritten', () => {
        expect(primarySourceFallback({ primary_metadata_source: '', cv_api_key: 'abc', metron_api_token: 'tok' })).toBeNull();
        expect(primarySourceFallback({ cv_api_key: 'abc' })).toBeNull();
        expect(primarySourceFallback({ primary_metadata_source: 'LOCAL', cv_api_key: 'abc' })).toBeNull();
    });
});
