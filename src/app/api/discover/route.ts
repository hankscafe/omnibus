export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db'; 

export async function GET(request: Request) {
  try {
      const { searchParams } = new URL(request.url);
      const type = searchParams.get('type') || 'popular'; 
      const offset = parseInt(searchParams.get('offset') || '0', 10);
      const limit = parseInt(searchParams.get('limit') || '14', 10);
      
      const cacheKey = type === 'new' ? 'discover_cache_new' : 'discover_cache_popular';
      
      const cache = await prisma.systemSetting.findUnique({
          where: { key: cacheKey }
      });

      if (cache && cache.value) {
          const allResults = JSON.parse(cache.value);
          
          // Slice the array based on the requested page
          const results = allResults.slice(offset, offset + limit);
          
          // If there's more data left in the cache, provide a nextOffset
          const nextOffset = (offset + limit < allResults.length) ? offset + limit : null;

          return NextResponse.json({ results, nextOffset });
      }

      return NextResponse.json({ results: [], nextOffset: null });

  } catch (error) {
      Logger.log('Discovery API Error:', error, 'error');
      return NextResponse.json({ results: [], nextOffset: null }); 
  }
}