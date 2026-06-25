import { NextResponse } from 'next/server';
import { ProwlarrService } from '@/lib/prowlarr';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Defense-in-depth behind the middleware /api/admin/* gate — enforce admin in-handler too.
  const session = await getServerSession(await getAuthOptions());
  if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const year = searchParams.get('year') || undefined;

  if (!query) {
    return NextResponse.json({ error: "Search query required" }, { status: 400 });
  }

  try {
    Logger.log(`[Manual Search] Searching Prowlarr for: ${query} (Year: ${year || 'Any'})`, 'info');
    
    // --- THE FIX: Pass `true` so the engine knows it's an Interactive search
    // and doesn't aggressively filter out results with messy titles.
    const results = await ProwlarrService.searchComics(query, true, false, year);
    
    return NextResponse.json({ results });
  } catch (error: unknown) {
    Logger.log(`Search API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}