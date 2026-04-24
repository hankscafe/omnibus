import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt2FA, decrypt2FA } from '@/lib/encryption';

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

vi.mock('@/lib/logger', () => ({
    Logger: { log: mocks.log }
}));

describe('Security: 2FA Encryption Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Provide a valid fake secret for the tests
        process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    });

    it('should successfully encrypt and perfectly decrypt a 2FA secret', async () => {
        mocks.findUnique.mockResolvedValue(null); // Fallback to process.env.NEXTAUTH_SECRET

        const rawSecret = 'JBSWY3DPEHPK3PXP';
        
        // 1. Encrypt
        const encrypted = await encrypt2FA(rawSecret);
        expect(encrypted).not.toBeNull();
        expect(encrypted).toContain('enc:v1:'); // Must have your custom prefix
        expect(encrypted).not.toBe(rawSecret);  // Must not be plaintext

        // 2. Decrypt
        const decrypted = await decrypt2FA(encrypted);
        expect(decrypted).toBe(rawSecret); // Must perfectly match the original
    });

    it('should bypass encryption if the string is already encrypted', async () => {
        const alreadyEncrypted = 'enc:v1:some_fake_iv:some_fake_ciphertext';
        const result = await encrypt2FA(alreadyEncrypted);
        
        // It should realize it's already encrypted and return it untouched
        expect(result).toBe(alreadyEncrypted);
    });

    it('should throw a critical error if the NEXTAUTH_SECRET is the default insecure string', async () => {
        // Simulate a user forgetting to change the default secret
        process.env.NEXTAUTH_SECRET = 'change_this_to_a_random_secure_string_123!';
        mocks.findUnique.mockResolvedValue(null); 

        await expect(encrypt2FA('secret')).rejects.toThrow('CRITICAL SECURITY ERROR');
    });

    it('should throw an error if the ciphertext has been tampered with', async () => {
        mocks.findUnique.mockResolvedValue(null); 

        const rawSecret = 'JBSWY3DPEHPK3PXP';
        const encrypted = await encrypt2FA(rawSecret);
        
        // FIX: Break the AES padding and block-size by slicing off the end of the string
        const tampered = encrypted?.slice(0, -8); 
        
        await expect(decrypt2FA(tampered!)).rejects.toThrow('Decryption failed');
        expect(mocks.log).toHaveBeenCalled(); // Should log the tampering attempt
    });
});