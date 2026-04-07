// src/lib/encryption.ts
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

export async function encrypt2FA(text: string | null): Promise<string | null> {
    if (!text) return text;
    if (text.startsWith(PREFIX)) return text; 

    const iv = crypto.randomBytes(16);
    const key = await getEncryptionKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return `${PREFIX}${iv.toString('hex')}:${encrypted}`;
}

export async function decrypt2FA(text: string | null): Promise<string | null> {
    if (!text) return text;
    if (!text.startsWith(PREFIX)) return text; 

    try {
        const payload = text.slice(PREFIX.length); 
        const [ivHex, encryptedText] = payload.split(':');
        
        const iv = Buffer.from(ivHex, 'hex');
        const key = await getEncryptionKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        Logger.log("[Encryption] Failed to decrypt 2FA secret. DATABASE_ENCRYPTION_KEY or NEXTAUTH_SECRET may have changed.", 'error');
        throw new Error("Decryption failed");
    }
}