import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    
    if (!q) return NextResponse.json({ error: 'Query required' }, { status: 400 });

    try {
        Logger.log(`[Interactive Search] Fetching live results for: ${q}`, 'info');
        
        // Fetch from both sources simultaneously
        const [prowlarr, getComics] = await Promise.all([
            ProwlarrService.searchComics(q).catch(() => []),
            GetComicsService.search(q).catch(() => [])
        ]);

        return NextResponse.json({ prowlarr, getComics });
    } catch (error: any) {
        Logger.log(`[Interactive Search] Error: ${error.message}`, 'error');
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}