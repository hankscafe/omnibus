export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';

const BASE_URL = 'https://comicvine.gamespot.com/api';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

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
        resources: 'volume', // Good: This limits results to Series only
        limit: 20,           // Increased to 20 to give users more choices
        field_list: 'id,name,start_year,publisher,count_of_issues,image,deck,description' 
      },
      headers: {
        'User-Agent': 'Omnibus/1.0' 
      }
    });

    const results = response.data.results.map((vol: any) => {
      // Clean HTML from description more thoroughly
      let desc = vol.deck;
      if (!desc && vol.description) {
         desc = vol.description.replace(/<[^>]*>?/gm, '').trim();
         if (desc.length > 500) desc = desc.substring(0, 500) + '...';
      }

      return {
        id: vol.id,
        name: vol.name,
        // Ensure year and publisher are never undefined to prevent "wiping" database fields
        year: vol.start_year || null,
        publisher: vol.publisher?.name || 'Other',
        count: vol.count_of_issues || 0,
        image: vol.image?.medium_url || vol.image?.small_url || vol.image?.super_url,
        description: desc || "No description available."
      };
    });

    return NextResponse.json({ results });

  } catch (error) {
    console.error('ComicVine API Error:', error);
    return NextResponse.json({ error: 'Failed to fetch data from ComicVine' }, { status: 500 });
  }
}