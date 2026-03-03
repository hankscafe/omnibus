import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: "Search query required" }, { status: 400 });
  }

  try {
    console.log(`[Manual Search] Searching Prowlarr for: ${query}`);
    
    // CHANGED: We are now calling the correct function name 'searchComics'
    const results = await ProwlarrService.searchComics(query);
    
    return NextResponse.json({ results });
  } catch (error: any) {
    console.error("Search API Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}