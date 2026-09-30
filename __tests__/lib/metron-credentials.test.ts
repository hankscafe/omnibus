// __tests__/lib/metron-credentials.test.ts
//
// Metron beta 3 (#216 follow-up): Metron is retiring username/password sign-in for its API in favour
// of API tokens, and the client has accepted a token since beta.013 - but every page that shows or
// hides a Metron feature still asked "is there a username AND a password?", so a token-only install
// looked unconfigured (the settings page even switched its primary source back to ComicVine). One
// client-safe check now answers it everywhere.
import { describe, it, expect } from 'vitest';
import { metronCredentialKind, hasMetronCredentials } from '@/lib/metron/credentials';

describe('lib: which Metron credentials a settings map holds', () => {
    it('a token alone is enough, and wins over a username and password', () => {
        expect(metronCredentialKind({ metron_api_token: 'tok' })).toBe('token');
        expect(metronCredentialKind({ metron_api_token: 'tok', metron_user: 'adam', metron_pass: 'pw' })).toBe('token');
        expect(hasMetronCredentials({ metron_api_token: 'tok' })).toBe(true);
    });

    it('a username needs its password (and the other way round)', () => {
        expect(metronCredentialKind({ metron_user: 'adam', metron_pass: 'pw' })).toBe('password');
        expect(metronCredentialKind({ metron_user: 'adam' })).toBeNull();
        expect(metronCredentialKind({ metron_pass: 'pw' })).toBeNull();
        expect(hasMetronCredentials({ metron_user: 'adam', metron_pass: '' })).toBe(false);
    });

    it('blank and whitespace values are nothing', () => {
        expect(metronCredentialKind({})).toBeNull();
        expect(metronCredentialKind({ metron_api_token: '   ', metron_user: ' ', metron_pass: '' })).toBeNull();
        expect(metronCredentialKind({ metron_api_token: null, metron_user: undefined })).toBeNull();
    });

    it('a masked value counts: it is what the settings API returns for a stored secret', () => {
        expect(metronCredentialKind({ metron_api_token: '********' })).toBe('token');
        expect(metronCredentialKind({ metron_user: 'adam', metron_pass: '********' })).toBe('password');
    });

    it('reads the settings list /api/admin/config returns as well as a plain map', () => {
        const rows = [
            { key: 'cv_api_key', value: '********' },
            { key: 'metron_api_token', value: '********' },
        ];
        expect(metronCredentialKind(rows)).toBe('token');
        expect(hasMetronCredentials([{ key: 'metron_user', value: 'adam' }, { key: 'metron_pass', value: '********' }])).toBe(true);
        expect(hasMetronCredentials([{ key: 'metron_user', value: 'adam' }])).toBe(false);
        expect(hasMetronCredentials(undefined)).toBe(false);
    });
});
