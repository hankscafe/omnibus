// src/lib/encryption.ts
import crypto from 'crypto';
import { Logger } from './logger';
import { prisma } from './db';

// At-rest credential encryption. v2 is authenticated AES-256-GCM (tamper-detectable); v1 was
// unauthenticated AES-256-CBC. Reads transparently handle both formats so already-stored v1 values
// keep decrypting; every write produces v2, so secrets re-encrypt to the authenticated format the
// next time they're saved.
const ALGORITHM_GCM = 'aes-256-gcm';
const ALGORITHM_CBC = 'aes-256-cbc'; // legacy v1 read path only
const PREFIX_V2 = 'enc:v2:';
const PREFIX_V1 = 'enc:v1:';
const GCM_IV_BYTES = 12; // NIST-recommended IV length for GCM

function isEncrypted(text: string): boolean {
    return text.startsWith(PREFIX_V2) || text.startsWith(PREFIX_V1);
}

async function getEncryptionKey() {
    // Fetch the persistent key generated during database initialization
    const dbKey = await prisma.systemSetting.findUnique({
        where: { key: 'DATABASE_ENCRYPTION_KEY' }
    });

    let secret = dbKey?.value;

    // SECURITY FIX: Removed insecure string fallback.
    // If the DB key is missing, we must use the environment variable.
    if (!secret) {
        secret = process.env.NEXTAUTH_SECRET;
    }

    // CRITICAL FIX: Fail-fast if no secret is provided.
    if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
        throw new Error("CRITICAL SECURITY ERROR: NEXTAUTH_SECRET is missing or insecure. Encryption cannot proceed.");
    }

    // Derive a 32-byte key from the secret
    return crypto.createHash('sha256').update(String(secret)).digest();
}

export async function encryptSecret(text: string | null): Promise<string | null> {
    if (!text) return text;
    if (isEncrypted(text)) return text; // already encrypted (v1 or v2) — don't double-wrap

    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const key = await getEncryptionKey();
    const cipher = crypto.createCipheriv(ALGORITHM_GCM, key, iv);

    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${PREFIX_V2}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export async function decryptSecret(text: string | null): Promise<string | null> {
    if (!text) return text;
    if (!isEncrypted(text)) return text; // plaintext passthrough (unencrypted legacy value)

    try {
        const key = await getEncryptionKey();

        if (text.startsWith(PREFIX_V2)) {
            const [ivB64, authTagB64, ciphertextB64] = text.slice(PREFIX_V2.length).split(':');
            const iv = Buffer.from(ivB64, 'base64');
            const authTag = Buffer.from(authTagB64, 'base64');
            const ciphertext = Buffer.from(ciphertextB64, 'base64');

            const decipher = crypto.createDecipheriv(ALGORITHM_GCM, key, iv);
            decipher.setAuthTag(authTag); // GCM verifies this on final() — throws if the data was tampered with

            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return decrypted.toString('utf8');
        }

        // Legacy v1: unauthenticated AES-256-CBC. Kept so values written before the GCM migration
        // still decrypt; they upgrade to v2 the next time the secret is written.
        const [ivHex, encryptedText] = text.slice(PREFIX_V1.length).split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM_CBC, key, iv);

        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        Logger.log("[Encryption] Failed to decrypt a stored secret. The value may have been tampered with, or DATABASE_ENCRYPTION_KEY / NEXTAUTH_SECRET may have changed.", 'error');
        throw new Error("Decryption failed");
    }
}

// Back-compat aliases — the 2FA secret store predates this generic helper. New code should
// import encryptSecret/decryptSecret directly; these keep the original 2FA call sites working.
export const encrypt2FA = encryptSecret;
export const decrypt2FA = decryptSecret;
