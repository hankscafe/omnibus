// src/app/api/search/cover/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { MetronProvider } from '@/lib/metadata/providers/metron';

// One Metron series' cover, for a search result someone is about to look at (Metron beta 4). Metron's
// series search carries no image - a cover costs one request - so Smart Match's Auto-Scan searches
// without covers and asks here for the one suggestion it shows. Optional on Metron's side: when no
// request slot is free it answers null instead of waiting. ComicVine search results already carry images.
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id') || '';
    if (searchParams.get('provider') !== 'METRON' || !/^\d+$/.test(id)) {
        return NextResponse.json({ error: 'A numeric Metron series id is required' }, { status: 400 });
    }
    const cover = await new MetronProvider().seriesCover(id);
    return NextResponse.json({ image: cover ? `/api/library/cover?path=${encodeURIComponent(cover)}` : null });
}
