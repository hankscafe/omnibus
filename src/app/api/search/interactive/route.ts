import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    
    if (!q) return NextResponse.json({ error: 'Query required' }, { status: 400 });

    try {
        Logger.log(`[Interactive Search] Fetching live results for: ${q}`, 'info');
        
        const [prowlarr, getcomics] = await Promise.all([
            ProwlarrService.searchComics(q, true, false).catch(() => []),
            GetComicsService.search(q, true, false).catch(() => [])
        ]);

        return NextResponse.json({ prowlarr, getcomics });
    } catch (error: unknown) {
        Logger.log(`[Interactive Search] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}