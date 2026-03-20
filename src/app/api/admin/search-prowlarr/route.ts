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
    
    // CHANGED: We are now calling the correct function name 'searchComics'
    const results = await ProwlarrService.searchComics(query);
    
    return NextResponse.json({ results });
  } catch (error: unknown) {
    Logger.log(`Search API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}