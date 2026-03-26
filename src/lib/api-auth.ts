// src/lib/api-auth.ts
import { prisma } from './db';
import crypto from 'crypto';

export async function validateApiKey(req: Request) {
    const authHeader = req.headers.get('authorization') || '';
    const tokenFromBearer = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '').trim() : null;
    
    // Parse HTTP Basic Auth for OPDS/External Apps
    let basicAuthPassword = null;
    if (authHeader.toLowerCase().startsWith('basic ')) {
        try {
            // Safely grab everything after "Basic " regardless of casing
            const base64Credentials = authHeader.substring(6).trim();
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            
            // Split by the FIRST colon to safely separate username and password
            const colonIndex = credentials.indexOf(':');
            if (colonIndex > -1) {
                basicAuthPassword = credentials.substring(colonIndex + 1).trim();
            }
        } catch (e) { }
    }

    const apiKeyHeader = req.headers.get('x-api-key')?.trim();
    const url = new URL(req.url);
    const apiKeyQuery = url.searchParams.get('apiKey')?.trim();

    const providedKey = apiKeyHeader || tokenFromBearer || basicAuthPassword || apiKeyQuery;
    
    if (!providedKey) return { valid: false, user: null, keyType: null };

    const keyHash = crypto.createHash('sha256').update(providedKey).digest('hex');

    try {
        // 1. Check Admin API Keys
        const adminKey = await prisma.apiKey.findUnique({
            where: { keyHash },
            include: { user: true }
        });

        if (adminKey) {
            if (adminKey.expiresAt && new Date() > adminKey.expiresAt) {
                return { valid: false, user: null, keyType: null, error: "API Key has expired." };
            }
            prisma.apiKey.update({ where: { id: adminKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
            return { valid: true, user: adminKey.user, keyType: 'ADMIN_KEY' };
        }

        // 2. Check User OPDS Keys
        const opdsKey = await prisma.opdsKey.findUnique({
            where: { keyHash },
            include: { user: true }
        });

        if (opdsKey) {
            prisma.opdsKey.update({ where: { id: opdsKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
            return { valid: true, user: opdsKey.user, keyType: 'OPDS_KEY' };
        }

    } catch (e) {
        // Ignore crypto/db errors to allow fallback checking
    }

    // 3. Legacy Check
    try {
        const legacySetting = await prisma.systemSetting.findUnique({ where: { key: 'omnibus_api_key' } });
        if (legacySetting?.value && legacySetting.value.trim() === providedKey) {
            return { valid: true, user: null, keyType: 'LEGACY_ADMIN' }; 
        }
    } catch (e) {}

    return { valid: false, user: null, keyType: null, error: "Invalid API Key." };
}