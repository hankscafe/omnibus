// src/app/api/search/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { ComicVineVolume, FormattedSearchResult } from '@/types'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { logApiUsage } from '@/lib/utils/system-flags';

const BASE_URL = 'https://comicvine.gamespot.com/api';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const provider = searchParams.get('provider') || 'COMICVINE';
  
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = 40; // Increased to 40 to mitigate pagination gaps after filtering

  if (!query) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  try {
    // --- FETCH SETTINGS (Including new Foreign Publisher Filter) ---
    const settings = await prisma.systemSetting.findMany({
        where: { key: { in: ['cv_api_key', 'filter_foreign_publishers'] } }
    });
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    const blockedForeignPublishers = config.filter_foreign_publishers 
        ? config.filter_foreign_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) 
        : [];

    if (provider === 'METRON') {
        const metron = new MetronProvider();
        const mdResults = await metron.searchSeries(query);
        await logApiUsage('metron', '/search')
        let results = mdResults.map((r: any) => ({
            id: r.sourceId,
            name: r.name,
            year: r.year,
            publisher: r.publisher,
            count: 0,
            image: r.coverUrl ? `/api/library/cover?path=${encodeURIComponent(r.coverUrl)}` : null, 
            description: r.description || "No description available."
        }));

        // Apply foreign publisher filter to Metron
        if (blockedForeignPublishers.length > 0) {
            results = results.filter((r: any) => {
                const pub = (r.publisher || "").toLowerCase();
                return !blockedForeignPublishers.some((bp: string) => pub.includes(bp));
            });
        }

        return NextResponse.json({ results, hasMore: false }); 
    }

    const CV_API_KEY = config.cv_api_key || process.env.CV_API_KEY;

    if (!CV_API_KEY) {
      return NextResponse.json({ error: 'Server configuration error: Missing API Key' }, { status: 500 });
    }

    const response = await axios.get(`${BASE_URL}/search/`, {
      params: {
        api_key: CV_API_KEY, format: 'json', query: query, resources: 'volume', limit: limit, page: page,
        field_list: 'id,name,start_year,publisher,count_of_issues,image,deck,description' 
      },
      headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    
    await logApiUsage('comicvine', '/search');

    if (!response.data || !Array.isArray(response.data.results)) {
        return NextResponse.json({ results: [], hasMore: false });
    }

    let results: FormattedSearchResult[] = response.data.results.map((vol: ComicVineVolume) => {
      let desc = vol.deck;
      if (!desc && vol.description) {
         desc = vol.description.replace(/<[^>]*>?/gm, '').trim();
         if (desc.length > 500) desc = desc.substring(0, 500) + '...';
      }

      const rawImage = vol.image?.medium_url || vol.image?.small_url || vol.image?.super_url || null;

      return {
        id: vol.id, name: vol.name, year: vol.start_year || null,
        publisher: vol.publisher?.name || 'Other', count: vol.count_of_issues || 0,
        image: rawImage ? `/api/library/cover?path=${encodeURIComponent(rawImage)}` : null,
        description: desc || "No description available."
      };
    });

    // --- APPLY FOREIGN PUBLISHER BLOCKLIST TO COMICVINE ---
    if (blockedForeignPublishers.length > 0) {
        results = results.filter((r: FormattedSearchResult) => {
            const pub = (r.publisher || "").toLowerCase();
            return !blockedForeignPublishers.some((bp: string) => pub.includes(bp));
        });
    }

    const totalResults = response.data.number_of_total_results || 0;
    const hasMore = (page * limit) < totalResults;

    return NextResponse.json({ results, hasMore });

  } catch (error) {
    Logger.log(`API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
}