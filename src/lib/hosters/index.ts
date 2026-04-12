// src/lib/hosters/index.ts
import { prisma } from '@/lib/db';
import { Logger } from '../logger';
import { resolveMediaFire } from './mediafire';
import { resolvePixeldrain } from './pixeldrain';
import { resolveMega } from './mega';
import { resolveRootz } from './rootz';
import { resolveVikingfile } from './vikingfile';
import { resolveTerabox } from './terabox';

export interface HosterResolveResult {
    success: boolean;
    directUrl?: string;
    headers?: Record<string, string>;
    isMegaStream?: boolean;
    megaFileNode?: any;
    fileName?: string;
    error?: string;
}

export const HosterEngine = {
    async resolveLink(url: string, hoster: string): Promise<HosterResolveResult> {
        Logger.log(`[Hoster Engine] Attempting to resolve ${hoster} link...`, 'info');

        const account = await prisma.hosterAccount.findFirst({
            where: { hoster, isActive: true }
        });

        try {
            switch (hoster) {
                case 'mediafire':
                    return await resolveMediaFire(url, account);
                case 'pixeldrain':
                    return await resolvePixeldrain(url, account);
                case 'mega':
                    return await resolveMega(url, account);
                case 'rootz':
                    return await resolveRootz(url, account);
                case 'vikingfile':
                    return await resolveVikingfile(url, account);
                case 'terabox':
                    return await resolveTerabox(url, account);
                default:
                    return { success: false, error: `No resolver found for hoster: ${hoster}` };
            }
        } catch (error: any) {
            Logger.log(`[Hoster Engine] Resolution failed for ${hoster}: ${error.message}`, 'error');
            return { success: false, error: error.message };
        }
    }
};