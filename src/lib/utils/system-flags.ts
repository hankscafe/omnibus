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