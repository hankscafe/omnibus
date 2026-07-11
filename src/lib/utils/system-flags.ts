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

// Total calls recorded for a provider inside its rolling window (Node + engine write the same
// SystemSetting counters, so this sees combined traffic). Budget gate for opt-in Metron
// detail-credit calls; malformed/absent JSON counts as zero.
export async function countApiUsage(service: 'comicvine' | 'metron'): Promise<number> {
    const key = service === 'comicvine' ? 'cv_api_usage' : 'metron_api_usage';
    const windowMs = service === 'comicvine' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const now = Date.now();
    try {
        const existing = await prisma.systemSetting.findUnique({ where: { key } });
        if (!existing?.value) return 0;
        const usage: Record<string, number[]> = JSON.parse(existing.value);
        return Object.values(usage).reduce(
            (sum, arr) => sum + (Array.isArray(arr) ? arr.filter(ts => now - ts < windowMs).length : 0),
            0
        );
    } catch {
        return 0;
    }
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