export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';

const BASE_URL = 'https://comicvine.gamespot.com/api';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  
  // NEW: Add pagination parameters
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = 20;
  const offset = (page - 1) * limit;

  if (!query) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'cv_api_key' }
  });
  const CV_API_KEY = setting?.value || process.env.CV_API_KEY;

  if (!CV_API_KEY) {
    return NextResponse.json({ error: 'Server configuration error: Missing API Key' }, { status: 500 });
  }

  try {
    const response = await axios.get(`${BASE_URL}/search/`, {
      params: {
        api_key: CV_API_KEY,
        format: 'json',
        query: query,
        resources: 'volume', 
        limit: limit,           
        offset: offset, // NEW: Tell CV which page we want
        field_list: 'id,name,start_year,publisher,count_of_issues,image,deck,description' 
      },
      headers: {
        'User-Agent': 'Omnibus/1.0' 
      }
    });

    const results = response.data.results.map((vol: any) => {
      let desc = vol.deck;
      if (!desc && vol.description) {
         desc = vol.description.replace(/<[^>]*>?/gm, '').trim();
         if (desc.length > 500) desc = desc.substring(0, 500) + '...';
      }

      return {
        id: vol.id,
        name: vol.name,
        year: vol.start_year || null,
        publisher: vol.publisher?.name || 'Other',
        count: vol.count_of_issues || 0,
        image: vol.image?.medium_url || vol.image?.small_url || vol.image?.super_url,
        description: desc || "No description available."
      };
    });

    // NEW: Calculate if there are more pages left
    const totalResults = response.data.number_of_total_results || 0;
    const hasMore = offset + limit < totalResults;

    return NextResponse.json({ results, hasMore });

  } catch (error) {
    console.error('ComicVine API Error:', error);
    return NextResponse.json({ error: 'Failed to fetch data from ComicVine' }, { status: 500 });
  }
}