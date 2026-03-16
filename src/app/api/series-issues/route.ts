export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { parseComicVineCredits } from '@/lib/utils';

const BASE_URL = 'https://comicvine.gamespot.com/api';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const volumeId = searchParams.get('volumeId');

  if (!volumeId) {
    return NextResponse.json({ error: 'Volume ID required' }, { status: 400 });
  }
  
  // 1. FETCH KEY FROM DB
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'cv_api_key' }
  });
  const CV_API_KEY = setting?.value || process.env.CV_API_KEY;

  if (!CV_API_KEY) {
    return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });
  }

  try {
    let allResults: any[] = [];
    let offset = 0;
    let totalResults = 1; // Initialized to 1 so the loop starts
    let loopCount = 0;    // Safety net to prevent infinite loops

    // 2. PAGINATION LOOP
    while (offset < totalResults && loopCount < 20) {
      const response = await axios.get(`${BASE_URL}/issues/`, {
        params: {
          api_key: CV_API_KEY,
          format: 'json',
          filter: `volume:${volumeId}`,
          sort: 'issue_number:asc',
          limit: 100,
          offset: offset,
          field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description,volume,person_credits,site_detail_url'
        },
        headers: { 'User-Agent': 'Omnibus/1.0' }
      });

      const data = response.data;
      
      if (offset === 0) {
        totalResults = data.number_of_total_results || 0;
      }

      const pageResults = (data.results || []).map((item: any) => {
        let desc = item.deck;
        if (!desc && item.description) {
           desc = item.description.replace(/<[^>]*>?/gm, '');
           if (desc.length > 800) desc = desc.substring(0, 800) + '...';
        }

        // Use the centralized metadata parser
        const { writers, artists, coverArtists } = parseComicVineCredits(item.person_credits);

        const dateStr = item.store_date || item.cover_date;
        const year = dateStr ? dateStr.split('-')[0] : '????';

        return {
          id: item.id,
          volumeId: item.volume.id,
          name: `${item.volume.name} #${item.issue_number}`,
          issueNumber: item.issue_number, 
          issue_number: item.issue_number, // FIX: Added this explicitly so frontend matching doesn't fail
          year: year,
          publisher: item.volume?.publisher?.name || null,
          image: item.image?.medium_url || item.image?.small_url || item.image?.super_url || null,
          description: desc || "No description available.",
          siteUrl: item.site_detail_url,
          writers: writers.slice(0, 3), 
          artists: artists.slice(0, 3),
          coverArtists: coverArtists.slice(0, 3),
        };
      });

      allResults.push(...pageResults);
      offset += 100;
      loopCount++;
    }

    return NextResponse.json({ results: allResults });

  } catch (error) {
    console.error('Series Issues API Error:', error);
    return NextResponse.json({ results: [] }); 
  }
}