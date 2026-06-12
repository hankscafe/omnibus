// src/app/api/search/interactive/route.ts
import { NextResponse } from 'next/server';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    const year = searchParams.get('year') || undefined;
    const isManga = searchParams.get('isManga') === 'true';

    if (!q) return NextResponse.json({ error: 'Query required' }, { status: 400 });

    try {
        Logger.log(`[Interactive Search] Forwarding live search for: "${q}" to Rust Engine...`, 'info');
        
        const rustResponse = await fetch(ENGINE_URL + '/api/search/interactive', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ query: q, year: year || null, is_manga: isManga })
        });

        if (!rustResponse.ok) throw new Error(`Rust HTTP error: ${rustResponse.status}`);
        
        // Rust returns exactly { prowlarr: [...], getcomics: [...] }
        const results = await rustResponse.json();
        return NextResponse.json(results);

    } catch (error: unknown) {
        Logger.log(`[Interactive Search] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}