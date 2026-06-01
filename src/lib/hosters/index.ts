// src/lib/hosters/index.ts
import { prisma } from '@/lib/db';
import { Logger } from '../logger';
import { resolveMediaFire } from './mediafire';
import { resolvePixeldrain } from './pixeldrain';
import { resolveMega } from './mega';
import { resolveRootz } from './rootz';
import { resolveVikingfile } from './vikingfile';
import { resolveTerabox } from './terabox';
import { resolveAnnasArchive } from './annas-archive';

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

        Logger.log(`[Hoster Engine Debug] Account configuration for ${hoster}: ${account ? 'Active (Premium)' : 'None (Anonymous)'}`, 'debug');

        try {
            let result: HosterResolveResult;

            switch (hoster) {
                case 'mediafire':
                    result = await resolveMediaFire(url, account);
                    break;
                case 'pixeldrain':
                    result = await resolvePixeldrain(url, account);
                    break;
                case 'mega':
                    result = await resolveMega(url, account);
                    break;
                case 'rootz':
                    result = await resolveRootz(url, account);
                    break;
                case 'vikingfile':
                    result = await resolveVikingfile(url, account);
                    break;
                case 'terabox':
                    result = await resolveTerabox(url, account);
                    break;
                case 'annas_archive':
                    result = await resolveAnnasArchive(url, account);
                    break;
                default:
                    result = { success: false, error: `No resolver found for hoster: ${hoster}` };
            }

            Logger.log(`[Hoster Engine Debug] Resolution result for ${hoster}: ${result.success ? 'Success' : 'Failed'}`, 'debug');
            return result;

        } catch (error: any) {
            Logger.log(`[Hoster Engine Debug] Uncaught exception during resolution: ${error.message}`, 'debug');
            Logger.log(`[Hoster Engine] Resolution failed for ${hoster}: ${error.message}`, 'error');
            return { success: false, error: error.message };
        }
    }
};