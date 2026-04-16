// src/lib/utils/system-flags.ts
import { prisma } from '@/lib/db';

export async function markSystemFlag(flag: 'cloudflare_block_time' | 'cv_rate_limit_time' | 'metron_rate_limit_time' | 'hoster_rate_limit_time') {
    try {
        await prisma.systemSetting.upsert({
            where: { key: flag },
            update: { value: Date.now().toString() },
            create: { key: flag, value: Date.now().toString() }
        });
    } catch (e) {}
}

export async function logApiUsage(service: 'comicvine' | 'metron', endpoint: string, count: number = 1) {
    const key = service === 'comicvine' ? 'cv_api_usage' : 'metron_api_usage';
    // ComicVine limits are hourly. Metron limits are daily.
    const windowMs = service === 'comicvine' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000; 
    const now = Date.now();

    try {
        const existing = await prisma.systemSetting.findUnique({ where: { key } });
        let usage: Record<string, number[]> = {};
        
        if (existing?.value) {
            try { usage = JSON.parse(existing.value); } catch(e) {}
        }

        if (!usage[endpoint]) usage[endpoint] = [];

        // Add new timestamps for each call made
        for (let i = 0; i < count; i++) {
            usage[endpoint].push(now);
        }

        // Clean up old timestamps across all endpoints
        for (const ep in usage) {
            usage[ep] = usage[ep].filter(ts => now - ts < windowMs);
            if (usage[ep].length === 0) delete usage[ep]; // Remove empty endpoints to save space
        }

        await prisma.systemSetting.upsert({
            where: { key },
            update: { value: JSON.stringify(usage) },
            create: { key, value: JSON.stringify(usage) }
        });
    } catch (e) {}
}