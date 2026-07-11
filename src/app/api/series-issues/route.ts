// src/app/api/series-issues/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { parseComicVineCredits, isReleasedYet } from '@/lib/utils';
import { ComicVineIssue } from '@/types'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { logApiUsage } from '@/lib/utils/system-flags';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { getMetronCover } from '@/lib/metadata/providers/metron-cover';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';

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
    metadataSource?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const volumeId = searchParams.get('volumeId');
  const provider = searchParams.get('provider') || 'COMICVINE';

  if (!volumeId || volumeId === '0' || volumeId === 'undefined' || volumeId === 'null') {
    return NextResponse.json({ results: [] });
  }

  if (provider === 'METRON') {
      try {
          const metron = new MetronProvider();
          const issues = await metron.getSeriesIssues(volumeId);
          
          const mapped = issues.map(item => ({
              id: parseInt(item.sourceId),
              volumeId: parseInt(volumeId),
              name: item.name || `Issue #${item.issueNumber}`,
              issueNumber: item.issueNumber,
              issue_number: item.issueNumber, 
              year: item.releaseDate ? item.releaseDate.split('-')[0] : '????',
              isReleased: isReleasedYet(item.releaseDate, item.releaseDate),
              publisher: null, 
              image: item.coverUrl ? `/api/library/cover?path=${encodeURIComponent(item.coverUrl)}` : null,
              description: item.description || "No description available.",
              siteUrl: `https://metron.cloud/issue/${item.sourceId}/`,
              writers: item.writers.slice(0, 3),
              artists: item.artists.slice(0, 3),
              coverArtists: (item.coverArtists || []).slice(0, 3),
              metadataSource: 'METRON'
          }));
          
          return NextResponse.json({ results: mapped });
      } catch (error) {
          Logger.log(`Series Issues API Error (Metron): ${getErrorMessage(error)}`, 'error');
          return NextResponse.json({ results: [] }); 
      }
  }

  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'cv_api_key' }
  });
  const CV_API_KEY = setting?.value || process.env.CV_API_KEY;

  if (!CV_API_KEY) {
    return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });
  }

  const metronUserSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
  const metronPassSetting = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });

  try {
    const allResults: MappedIssueResult[] = []; 
    let offset = 0;
    let totalResults = 1; 
    let loopCount = 0;    

    while (offset < totalResults && loopCount < 20) {
      const response = await cachedCvGet(`${BASE_URL}/issues/`, {
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
      if (offset === 0) totalResults = data.number_of_total_results || 0;

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

        if (!isReleased && (!rawImage || rawImage.includes('placeholder') || rawImage.includes('default'))) {
            const fallback = await getMetronCover(item.volume.name, item.issue_number, metronUserSetting?.value, metronPassSetting?.value);
            if (fallback) rawImage = fallback;
        }

        let issueName = `${item.volume.name} #${item.issue_number}`;
        if (item.name && item.name !== item.volume.name && !item.name.includes(`#${item.issue_number}`)) {
            issueName += `: ${item.name}`;
        } else if (item.name && item.name.includes(`#${item.issue_number}`)) {
            issueName = item.name;
        }

        return {
          id: item.id,
          volumeId: item.volume.id,
          name: issueName,
          issueNumber: item.issue_number, 
          issue_number: item.issue_number, 
          year: year,
          isReleased: isReleased,
          publisher: item.volume?.publisher?.name || null,
          image: rawImage ? `/api/library/cover?path=${encodeURIComponent(rawImage)}` : null,
          description: desc || "No description available.",
          siteUrl: item.site_detail_url,
          writers: writers.slice(0, 3), 
          artists: artists.slice(0, 3),
          coverArtists: coverArtists.slice(0, 3),
          metadataSource: 'COMICVINE'
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