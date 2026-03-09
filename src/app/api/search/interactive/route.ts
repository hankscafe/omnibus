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
        
        // Pass 'true' for the second parameter to trigger the "Interactive Bypass" 
        // which skips the strict regex filtering.
        const [prowlarr, getcomics] = await Promise.all([
            ProwlarrService.searchComics(q, true).catch(() => []),
            GetComicsService.search(q, true).catch(() => [])
        ]);

        // Unified lowercase keys to match the frontend expectations
        return NextResponse.json({ prowlarr, getcomics });
    } catch (error: any) {
        Logger.log(`[Interactive Search] Error: ${error.message}`, 'error');
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}