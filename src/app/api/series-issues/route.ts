export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { parseComicVineCredits, isReleasedYet } from '@/lib/utils';
import { ComicVineIssue } from '@/types'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { logApiUsage } from '@/lib/utils/system-flags';

const BASE_URL = 'https://comicvine.gamespot.com/api';

interface MappedIssueResult {
    id: number;
    volumeId: number;
    name: string;
    issueNumber: string;
    issue_number: string;
    year: string;
    publisher: string | null;
    image: string | null;
    description: string;
    siteUrl: string;
    writers: string[];
    artists: string[];
    coverArtists: string[];
}

// --- NEW: Helper to securely fetch from Metron ---
const getMetronCover = async (seriesName: string, issueNumber: string, user?: string, pass?: string) => {
    if (!user || !pass) return null;
    try {
        const res = await axios.get(`https://metron.cloud/api/issue/`, {
            params: { series_name: seriesName, number: issueNumber },
            auth: { username: user, password: pass },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 4000
        });
        return res.data?.results?.[0]?.image || null;
    } catch (e) {
        return null;
    }
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const volumeId = searchParams.get('volumeId');

  if (!volumeId) {
    return NextResponse.json({ error: 'Volume ID required' }, { status: 400 });
  }
  
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'cv_api_key' }
  });
  const CV_API_KEY = setting?.value || process.env.CV_API_KEY;

  if (!CV_API_KEY) {
    return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });
  }

  // Grab Metron credentials for fallback lookups
  const metronUserSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
  const metronPassSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });

  try {
    const allResults: MappedIssueResult[] = []; 
    let offset = 0;
    let totalResults = 1; 
    let loopCount = 0;    

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
      await logApiUsage('comicvine', '/issues');

      const data = response.data;
      if (offset === 0) totalResults = data.number_of_total_results || 0;

      // --- FIXED: Async mapping to allow Metron fallback ---
      const pageResults: MappedIssueResult[] = await Promise.all((data.results || []).map(async (item: ComicVineIssue) => {
        let desc = item.deck;
        if (!desc && item.description) {
           desc = item.description.replace(/<[^>]*>?/gm, '');
           if (desc.length > 800) desc = desc.substring(0, 800) + '...';
        }

        const { writers, artists, coverArtists } = parseComicVineCredits(item.person_credits || undefined);

        const dateStr = item.store_date || item.cover_date;
        const year = dateStr ? dateStr.split('-')[0] : '????';
        const isReleased = isReleasedYet(item.store_date, item.cover_date);
        
        let rawImage = item.image?.medium_url || item.image?.small_url || item.image?.super_url || null;

        // --- NEW: Metron Fallback Logic ---
        // If the issue is unreleased AND ComicVine returned a generic placeholder, check Metron
        if (!isReleased && (!rawImage || rawImage.includes('placeholder') || rawImage.includes('default'))) {
            const fallback = await getMetronCover(item.volume.name, item.issue_number, metronUserSetting?.value, metronPassSetting?.value);
            if (fallback) rawImage = fallback;
        }

        return {
          id: item.id,
          volumeId: item.volume.id,
          name: `${item.volume.name} #${item.issue_number}`,
          issueNumber: item.issue_number, 
          issue_number: item.issue_number, 
          year: year,
          publisher: item.volume?.publisher?.name || null,
          image: rawImage ? `/api/library/cover?path=${encodeURIComponent(rawImage)}` : null,
          description: desc || "No description available.",
          siteUrl: item.site_detail_url,
          writers: writers.slice(0, 3), 
          artists: artists.slice(0, 3),
          coverArtists: coverArtists.slice(0, 3),
        };
      }));

      allResults.push(...pageResults);
      offset += 100;
      loopCount++;
    }

    return NextResponse.json({ results: allResults });

  } catch (error) {
    Logger.log(`Series Issues API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ results: [] }); 
  }
}