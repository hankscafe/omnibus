import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    
    if (!q) return NextResponse.json({ error: 'Query required' }, { status: 400 });

    try {
        Logger.log(`[Interactive Search] Fetching live results for: ${q}`, 'info');
        
        // 1. Fetch hoster settings to check if ANY are enabled
        const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
        let hasEnabledHosters = true;
        
        if (hpSetting?.value) {
            try {
                const parsed = JSON.parse(hpSetting.value);
                if (parsed.length > 0 && typeof parsed[0] === 'object') {
                    const enabledHosters = parsed.filter((p: any) => p.enabled).map((p: any) => p.hoster);
                    hasEnabledHosters = enabledHosters.length > 0;
                }
            } catch(e) {}
        }

        const promises = [
            ProwlarrService.searchComics(q, true, false).catch(() => [])
        ];

        // 2. Only query GetComics if the user has at least one file hoster enabled
        if (hasEnabledHosters) {
            promises.push(GetComicsService.search(q, true, false).catch(() => []));
        }

        const results = await Promise.all(promises);

        return NextResponse.json({ 
            prowlarr: results[0], 
            getcomics: hasEnabledHosters ? results[1] : [] 
        });
    } catch (error: unknown) {
        Logger.log(`[Interactive Search] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}