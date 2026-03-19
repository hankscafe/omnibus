import crypto from 'crypto';
import { Logger } from './logger';

const ALGORITHM = 'aes-256-cbc';
const PREFIX = 'enc:v1:';

function getEncryptionKey() {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) throw new Error("NEXTAUTH_SECRET is not set.");
    // Derive a 32-byte key from the secret
    return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypts a plaintext 2FA secret. 
 * Returns the prefixed string containing the IV and ciphertext.
 */
export function encrypt2FA(text: string | null): string | null {
    if (!text) return text;
    if (text.startsWith(PREFIX)) return text; // Already encrypted

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Format: enc:v1:<iv_hex>:<ciphertext_hex>
    return `${PREFIX}${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a 2FA secret.
 * If the secret lacks the encryption prefix, it assumes it is a legacy plaintext secret and returns it as-is.
 */
export function decrypt2FA(text: string | null): string | null {
    if (!text) return text;
    if (!text.startsWith(PREFIX)) return text; // Legacy plaintext fallback

    try {
        const payload = text.slice(PREFIX.length); // Remove 'enc:v1:'
        const [ivHex, encryptedText] = payload.split(':');
        
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
        
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        Logger.log("[Encryption] Failed to decrypt 2FA secret. NEXTAUTH_SECRET may have changed.", 'error');
        throw new Error("Decryption failed");
    }
}