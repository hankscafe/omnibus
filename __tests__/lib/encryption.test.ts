import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { encryptSecret, decryptSecret, encrypt2FA, decrypt2FA, __resetEncryptionKeyCacheForTests } from '@/lib/encryption';
import { loggerLog } from '../helpers/setup-global';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    findUnique: vi.fn(),
    log: vi.fn()
}));

// 2. Mock the DB and Logger
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.findUnique }
    }
}));


// Default deterministic key source (a DATABASE_ENCRYPTION_KEY row). getEncryptionKey() derives the
// AES key as sha256(secret), so the test can reproduce it to hand-craft legacy v1 values.
const TEST_SECRET = 'unit-test-encryption-key-0123456789abcdef';

function derivedKey() {
    return crypto.createHash('sha256').update(TEST_SECRET).digest();
}

// Reproduce the pre-migration v1 format (unauthenticated AES-256-CBC) exactly as the old code wrote it.
function makeLegacyV1(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', derivedKey(), iv);
    const encrypted = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    return `enc:v1:${iv.toString('hex')}:${encrypted}`;
}

describe('Security: Credential Encryption Engine (AES-256-GCM)', () => {
    beforeEach(() => {
        __resetEncryptionKeyCacheForTests();
        mocks.findUnique.mockResolvedValue({ value: TEST_SECRET });
        process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    });

    it('resolves the derived key ONCE per process, never per call (#195 deadlock guard)', async () => {
        // getEncryptionKey used to query the DB on every encrypt/decrypt — from inside an
        // interactive transaction that query queued behind the transaction's own connection on
        // the single-connection SQLite pool and deadlocked the settings save. The key material
        // is static per boot, so it must be fetched exactly once.
        await encryptSecret('first');
        await encryptSecret('second');
        await decryptSecret(await encryptSecret('third'));
        expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    });

    it('encrypts to the authenticated v2 format and round-trips back to the plaintext', async () => {
        const rawSecret = 'JBSWY3DPEHPK3PXP';
        const encrypted = await encryptSecret(rawSecret);

        expect(encrypted).not.toBeNull();
        expect(encrypted!.startsWith('enc:v2:')).toBe(true); // authenticated GCM, no longer v1/CBC
        expect(encrypted).not.toBe(rawSecret);
        // enc:v2:<iv>:<tag>:<ciphertext> — five colon-separated fields.
        expect(encrypted!.split(':')).toHaveLength(5);

        expect(await decryptSecret(encrypted)).toBe(rawSecret);
    });

    it('uses a fresh IV per call, so the same plaintext encrypts to different ciphertexts', async () => {
        const a = await encryptSecret('repeated-value');
        const b = await encryptSecret('repeated-value');
        expect(a).not.toEqual(b);
        expect(await decryptSecret(a)).toBe('repeated-value');
        expect(await decryptSecret(b)).toBe('repeated-value');
    });

    it('detects tampering: corrupting a ciphertext byte fails the GCM auth tag', async () => {
        const encrypted = (await encryptSecret('tamper-me'))!;
        const [prefix, version, iv, tag, ct] = encrypted.split(':');
        const ctBytes = Buffer.from(ct, 'base64');
        ctBytes[0] ^= 0xff;
        const tampered = [prefix, version, iv, tag, ctBytes.toString('base64')].join(':');
        expect(tampered).not.toEqual(encrypted);

        await expect(decryptSecret(tampered)).rejects.toThrow('Decryption failed');
        expect(loggerLog).toHaveBeenCalled();
    });

    it('detects tampering: a corrupted auth tag fails to decrypt', async () => {
        const encrypted = (await encryptSecret('tag-tamper'))!;
        const [prefix, version, iv, tag, ct] = encrypted.split(':');
        const tagBytes = Buffer.from(tag, 'base64');
        tagBytes[0] ^= 0xff;
        const tampered = [prefix, version, iv, tagBytes.toString('base64'), ct].join(':');

        await expect(decryptSecret(tampered)).rejects.toThrow('Decryption failed');
    });

    it('detects tampering: a truncated ciphertext fails to decrypt and is logged', async () => {
        const encrypted = await encryptSecret('JBSWY3DPEHPK3PXP');
        const tampered = encrypted?.slice(0, -8);

        await expect(decryptSecret(tampered!)).rejects.toThrow('Decryption failed');
        expect(loggerLog).toHaveBeenCalled();
    });

    it('still decrypts legacy v1 (AES-256-CBC) values written before the migration', async () => {
        const legacy = makeLegacyV1('legacy-stored-password');
        expect(legacy.startsWith('enc:v1:')).toBe(true);
        expect(await decryptSecret(legacy)).toBe('legacy-stored-password');
    });

    it('is idempotent: re-encrypting an already-encrypted value (v1 or v2) returns it unchanged', async () => {
        const v2 = (await encryptSecret('once'))!;
        expect(await encryptSecret(v2)).toBe(v2);

        const v1 = makeLegacyV1('once');
        expect(await encryptSecret(v1)).toBe(v1);
    });

    it('passes null/empty and unencrypted plaintext through untouched', async () => {
        expect(await encryptSecret(null)).toBeNull();
        expect(await encryptSecret('')).toBe('');
        expect(await decryptSecret(null)).toBeNull();
        expect(await decryptSecret('not-encrypted-plaintext')).toBe('not-encrypted-plaintext');
    });

    it('keeps the encrypt2FA/decrypt2FA aliases working end-to-end', async () => {
        const encrypted = await encrypt2FA('JBSWY3DPEHPK3PXP');
        expect(encrypted).toContain('enc:v2:');
        expect(await decrypt2FA(encrypted)).toBe('JBSWY3DPEHPK3PXP');
    });

    it('falls back to NEXTAUTH_SECRET when no DATABASE_ENCRYPTION_KEY row exists', async () => {
        mocks.findUnique.mockResolvedValue(null); // forces the env fallback
        const encrypted = await encryptSecret('env-fallback-secret');
        expect(await decryptSecret(encrypted)).toBe('env-fallback-secret');
    });

    it('throws a critical error if the secret is the default insecure placeholder', async () => {
        mocks.findUnique.mockResolvedValue(null);
        process.env.NEXTAUTH_SECRET = 'change_this_to_a_random_secure_string_123!';

        await expect(encryptSecret('secret')).rejects.toThrow('CRITICAL SECURITY ERROR');
    });
});
