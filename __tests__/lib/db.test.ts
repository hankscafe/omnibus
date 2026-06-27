import { describe, it, expect, vi, beforeEach } from 'vitest';

// db.ts instantiates a PrismaClient at module load; stub @prisma/client so importing the module
// doesn't require a generated client or a DB connection.
vi.mock('@prisma/client', () => ({
    PrismaClient: class { $extends() { return this; } }
}));

const mocks = vi.hoisted(() => ({ decryptSecret: vi.fn() }));
vi.mock('@/lib/encryption', () => ({ decryptSecret: mocks.decryptSecret }));

import { decryptSettingRow } from '@/lib/db';

// Regression guard for the beta.058 GCM migration: encryptSecret started emitting enc:v2: (GCM), but
// this read-side extension only recognized enc:v1: (CBC), so newly-saved secret settings (cv_api_key,
// prowlarr_key, …) came back as the raw encrypted blob — "the API key won't save / doesn't work".
describe('db: SystemSetting decrypt-on-read extension', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.decryptSecret.mockImplementation(async (v: string) => `PLAIN(${v})`);
    });

    it('decrypts a current-format (enc:v2: GCM) secret-key value', async () => {
        const out = await decryptSettingRow({ key: 'cv_api_key', value: 'enc:v2:iv:tag:ct' });
        expect(out.value).toBe('PLAIN(enc:v2:iv:tag:ct)');
        expect(mocks.decryptSecret).toHaveBeenCalledWith('enc:v2:iv:tag:ct');
    });

    it('still decrypts a legacy (enc:v1: CBC) secret-key value', async () => {
        const out = await decryptSettingRow({ key: 'prowlarr_key', value: 'enc:v1:iv:ct' });
        expect(out.value).toBe('PLAIN(enc:v1:iv:ct)');
    });

    it('passes a plaintext secret-key value through untouched', async () => {
        const row = { key: 'cv_api_key', value: 'raw-plaintext-key' };
        expect(await decryptSettingRow(row)).toEqual(row);
        expect(mocks.decryptSecret).not.toHaveBeenCalled();
    });

    it('does not decrypt non-secret keys, even if they look encrypted', async () => {
        const row = { key: 'metron_user', value: 'enc:v2:not-a-secret' };
        expect(await decryptSettingRow(row)).toEqual(row);
        expect(mocks.decryptSecret).not.toHaveBeenCalled();
    });

    it('returns the row unchanged if decryption throws (e.g. the encryption key rotated)', async () => {
        mocks.decryptSecret.mockRejectedValueOnce(new Error('Decryption failed'));
        const row = { key: 'cv_api_key', value: 'enc:v2:tampered' };
        expect(await decryptSettingRow(row)).toEqual(row);
    });

    it('uses the keyHint when the row carries no key (findUnique/findFirst path)', async () => {
        const out = await decryptSettingRow({ value: 'enc:v2:x' }, 'cv_api_key');
        expect(out.value).toBe('PLAIN(enc:v2:x)');
    });
});
