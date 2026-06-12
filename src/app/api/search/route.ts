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
  const rawQuery = searchParams.get('q');
  let provider = searchParams.get('provider');
  
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = 40;

  if (!rawQuery) {
    return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 });
  }

  // --- SMART SEARCH: Extract Year and Clean Query ---
  const yearMatch = rawQuery.match(/\b(19\d{2}|20\d{2})\b/);
  const reqYear = yearMatch ? yearMatch[1] : null;
  
  // Updated to strip (), [], and {}
  const query = rawQuery.replace(/\s*[\(\[\{]?(19\d{2}|20\d{2})[\)\]\}]?\s*/g, ' ').trim() || rawQuery;

  try {
    const settings = await prisma.systemSetting.findMany({
        where: { key: { in: ['cv_api_key', 'filter_foreign_publishers', 'primary_metadata_source'] } }
    });
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (!provider) {
        provider = config.primary_metadata_source || 'COMICVINE';
    }

    // --- NEW: Robust Database Caching ---
    const cacheKey = `search_v3_${provider}_${rawQuery.toLowerCase().replace(/[^a-z0-9]/g, '_')}_p${page}`;
    const cachedData = await prisma.systemSetting.findUnique({ where: { key: cacheKey } });
    
    if (cachedData?.value) {
        try {
            const parsed = JSON.parse(cachedData.value);
            // Cache manual searches for 12 hours
            if (Date.now() - parsed.timestamp < 12 * 60 * 60 * 1000) { 
                return NextResponse.json({ results: parsed.results, hasMore: parsed.hasMore });
            }
        } catch (e) {}
    }

    const blockedForeignPublishers = config.filter_foreign_publishers 
        ? config.filter_foreign_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) 
        : [];

    let finalResults: any[] = [];
    let hasMore = false;

    if (provider === 'METRON') {
        const metron = new MetronProvider();
        const mdResults = await metron.searchSeries(query, page);
        await logApiUsage('metron', '/search');
        
        let results = mdResults.map((r: any) => ({
            id: r.sourceId,
            name: r.name,
            year: r.year,
            publisher: r.publisher,
            count: r.issueCount || 0,
            image: r.coverUrl ? `/api/library/cover?path=${encodeURIComponent(r.coverUrl)}` : null, 
            description: r.description || "No description available.",
            siteUrl: `https://metron.cloud/series/${r.sourceId}/`,
            metadataSource: 'METRON'
        }));

        if (blockedForeignPublishers.length > 0) {
            results = results.filter((r: any) => {
                const pub = (r.publisher || "").toLowerCase();
                return !blockedForeignPublishers.some((bp: string) => pub.includes(bp));
            });
        }

        finalResults = results;
        // Since we slice precisely 10 items in the provider, if we get 10 back, there's a strong chance of a next page.
        hasMore = mdResults.length === 10; 
    } else {
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
            description: desc || "No description available.",
            metadataSource: 'COMICVINE'
          };
        });

        if (blockedForeignPublishers.length > 0) {
            results = results.filter((r: FormattedSearchResult) => {
                const pub = (r.publisher || "").toLowerCase();
                return !blockedForeignPublishers.some((bp: string) => pub.includes(bp));
            });
        }

        const totalResults = response.data.number_of_total_results || 0;
        finalResults = results;
        hasMore = (page * limit) < totalResults;
    }

    // --- SORT BY EXTRACTED YEAR ---
    if (reqYear) {
        finalResults.sort((a, b) => {
            const aMatch = (a.year && a.year.toString() === reqYear) ? 1 : 0;
            const bMatch = (b.year && b.year.toString() === reqYear) ? 1 : 0;
            return bMatch - aMatch;
        });
    }

    // --- UPSERT CACHE ---
    await prisma.systemSetting.upsert({
        where: { key: cacheKey },
        update: { value: JSON.stringify({ timestamp: Date.now(), results: finalResults, hasMore }) },
        create: { key: cacheKey, value: JSON.stringify({ timestamp: Date.now(), results: finalResults, hasMore }) }
    });

    return NextResponse.json({ results: finalResults, hasMore });

  } catch (error) {
    Logger.log(`API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
}