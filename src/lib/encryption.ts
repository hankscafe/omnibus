import crypto from 'crypto';
import { Logger } from './logger';
import { prisma } from './db';

const ALGORITHM = 'aes-256-cbc';
const PREFIX = 'enc:v1:';

async function getEncryptionKey() {
    // Fetch the persistent key generated during database initialization
    const dbKey = await prisma.systemSetting.findUnique({
        where: { key: 'DATABASE_ENCRYPTION_KEY' }
    });

    let secret = dbKey?.value;

    // Fallback to NEXTAUTH_SECRET only if the DB key is missing 
    // to prevent immediate crashes for users migrating from older versions.
    if (!secret) {
        secret = process.env.NEXTAUTH_SECRET;
        if (!secret) throw new Error("No encryption key found in database or environment.");
    }

    // Derive a 32-byte key from the secret
    return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypts a plaintext 2FA secret. 
 * Returns the prefixed string containing the IV and ciphertext.
 */
export async function encrypt2FA(text: string | null): Promise<string | null> {
    if (!text) return text;
    if (text.startsWith(PREFIX)) return text; // Already encrypted

    const iv = crypto.randomBytes(16);
    const key = await getEncryptionKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Format: enc:v1:<iv_hex>:<ciphertext_hex>
    return `${PREFIX}${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a 2FA secret.
 * If the secret lacks the encryption prefix, it assumes it is a legacy plaintext secret and returns it as-is.
 */
export async function decrypt2FA(text: string | null): Promise<string | null> {
    if (!text) return text;
    if (!text.startsWith(PREFIX)) return text; // Legacy plaintext fallback

    try {
        const payload = text.slice(PREFIX.length); // Remove 'enc:v1:'
        const [ivHex, encryptedText] = payload.split(':');
        
        const iv = Buffer.from(ivHex, 'hex');
        const key = await getEncryptionKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        Logger.log("[Encryption] Failed to decrypt 2FA secret. DATABASE_ENCRYPTION_KEY may have changed.", 'error');
        throw new Error("Decryption failed");
    }
}