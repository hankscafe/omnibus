// src/app/api/search/interactive/route.ts
import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { searchAnnasArchive } from '@/lib/hosters/annas-archive';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    const year = searchParams.get('year') || undefined;
    const isManga = searchParams.get('isManga') === 'true';

    if (!q) return NextResponse.json({ error: 'Query required' }, { status: 400 });

    try {
        Logger.log(`[Interactive Search] Fetching live results for: ${q} (Year: ${year || 'Any'})`, 'info');
        Logger.log(`[Interactive Search Debug] Initializing interactive search for query: "${q}"`, 'debug');
        
        // --- THE FIX: Reordered to safely consume .mockResolvedValueOnce() during testing ---
        const hpSetting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
        const ddlSetting = await prisma.systemSetting.findUnique({ where: { key: 'ddl_enabled' } });
        
        const ddlEnabled = ddlSetting?.value !== 'false';
        let hasEnabledHosters = true;
        
        if (hpSetting?.value) {
            try {
                const val = hpSetting.value;
                const parsed = typeof val === 'string' ? JSON.parse(val) : val;
                
                if (Array.isArray(parsed)) {
                    if (parsed.length === 0) {
                        hasEnabledHosters = false;
                    } else if (typeof parsed[0] === 'object') {
                        const enabledHosters = parsed.filter((p: any) => p.enabled !== false).map((p: any) => p.hoster);
                        hasEnabledHosters = enabledHosters.length > 0;
                    } else if (typeof parsed[0] === 'string') {
                        hasEnabledHosters = parsed.length > 0;
                    }
                }
            } catch(e) {}
        }

        // Anna's Archive interactive search is opt-in (no API key needed for search) — read its gate.
        const annasSetting = await prisma.systemSetting.findUnique({ where: { key: 'annas_archive_interactive_enabled' } });
        const annasEnabled = annasSetting?.value === 'true';

        const prowlarrP = ProwlarrService.searchComics(q, true, false, year).catch(() => []);
        // 2. Only query GetComics if the user has DDL enabled AND at least one file hoster enabled
        const getcomicsP = (ddlEnabled && hasEnabledHosters)
            ? GetComicsService.search(q, true, false, undefined, year).catch(() => [])
            : Promise.resolve([] as any[]);
        const annasP = annasEnabled
            ? searchAnnasArchive([q], true, isManga, year).catch(() => [])
            : Promise.resolve([] as any[]);

        const [prowlarr, getcomics, annas_archive] = await Promise.all([prowlarrP, getcomicsP, annasP]);

        Logger.log(`[Interactive Search Debug] Search completed. Prowlarr: ${prowlarr?.length || 0}, GetComics: ${getcomics?.length || 0}, Anna's: ${annas_archive?.length || 0}`, 'debug');

        return NextResponse.json({
            prowlarr: prowlarr || [],
            getcomics: getcomics || [],
            annas_archive: annas_archive || [],
        });
    } catch (error: unknown) {
        Logger.log(`[Interactive Search] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}