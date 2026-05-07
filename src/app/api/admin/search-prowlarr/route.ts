import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: "Search query required" }, { status: 400 });
  }

  try {
    Logger.log(`[Manual Search] Searching Prowlarr for: ${query}`, 'info');
    
    // --- THE FIX: Pass `true` so the engine knows it's an Interactive search
    // and doesn't aggressively filter out results with messy titles.
    const results = await ProwlarrService.searchComics(query, true, false);
    
    return NextResponse.json({ results });
  } catch (error: unknown) {
    Logger.log(`Search API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}