export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { ComicVineVolume, FormattedSearchResult } from '@/types'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { MangaDexProvider } from '@/lib/metadata/providers/mangadex';

const BASE_URL = 'https://comicvine.gamespot.com/api';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const provider = searchParams.get('provider') || 'COMICVINE';
  
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = 20;

  if (!query) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  try {
    if (provider === 'MANGADEX') {
        const md = new MangaDexProvider();
        const mdResults = await md.searchSeries(query);
        const results = mdResults.map(r => ({
            id: r.sourceId,
            name: r.name,
            year: r.year,
            publisher: r.publisher,
            count: 0,
            image: r.coverUrl,
            description: r.description || "No description available."
        }));
        return NextResponse.json({ results, hasMore: false }); 
    }

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    const CV_API_KEY = setting?.value || process.env.CV_API_KEY;

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

    if (!response.data || !Array.isArray(response.data.results)) {
        return NextResponse.json({ results: [], hasMore: false });
    }

    const results: FormattedSearchResult[] = response.data.results.map((vol: ComicVineVolume) => {
      let desc = vol.deck;
      if (!desc && vol.description) {
         desc = vol.description.replace(/<[^>]*>?/gm, '').trim();
         if (desc.length > 500) desc = desc.substring(0, 500) + '...';
      }

      return {
        id: vol.id, name: vol.name, year: vol.start_year || null,
        publisher: vol.publisher?.name || 'Other', count: vol.count_of_issues || 0,
        image: vol.image?.medium_url || vol.image?.small_url || vol.image?.super_url || null,
        description: desc || "No description available."
      };
    });

    const totalResults = response.data.number_of_total_results || 0;
    const hasMore = (page * limit) < totalResults;

    return NextResponse.json({ results, hasMore });

  } catch (error) {
    Logger.log(`API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
}