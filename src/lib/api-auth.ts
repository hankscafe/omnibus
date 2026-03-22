// src/lib/api-auth.ts
import { prisma } from './db';
import crypto from 'crypto';

export async function validateApiKey(req: Request) {
    const authHeader = req.headers.get('authorization') || '';
    const tokenFromBearer = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '').trim() : null;
    const apiKeyHeader = req.headers.get('x-api-key')?.trim();
    
    const url = new URL(req.url);
    const apiKeyQuery = url.searchParams.get('apiKey')?.trim();

    const providedKey = apiKeyHeader || tokenFromBearer || apiKeyQuery;
    
    if (!providedKey) return { valid: false, user: null };

    // 1. Check New Secure API Key Table
    try {
        const keyHash = crypto.createHash('sha256').update(providedKey).digest('hex');
        const apiKeyRecord = await prisma.apiKey.findUnique({
            where: { keyHash },
            include: { user: true }
        });

        if (apiKeyRecord) {
            // Check expiration
            if (apiKeyRecord.expiresAt && new Date() > apiKeyRecord.expiresAt) {
                return { valid: false, user: null, error: "API Key has expired." };
            }
            
            // Fire & forget last used update
            prisma.apiKey.update({
                where: { id: apiKeyRecord.id },
                data: { lastUsedAt: new Date() }
            }).catch(() => {});

            return { valid: true, user: apiKeyRecord.user };
        }
    } catch (e) {
        // Ignore crypto/db errors to allow fallback checking
    }

    // 2. Legacy Check (backward compatibility for old 'omnibus_api_key' flat string)
    try {
        const legacySetting = await prisma.systemSetting.findUnique({ where: { key: 'omnibus_api_key' } });
        if (legacySetting?.value && legacySetting.value.trim() === providedKey) {
            return { valid: true, user: null }; 
        }
    } catch (e) {}

    return { valid: false, user: null, error: "Invalid API Key." };
}