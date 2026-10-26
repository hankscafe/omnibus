// src/app/api/search/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { ComicVineVolume } from '@/types';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';

const BASE_URL = 'https://comicvine.gamespot.com/api';

// Since about 2026-10-23 ComicVine's /search/ answers with stub volumes: the right id, name and
// start_year, but publisher null, count_of_issues 0 and CV's "Blank!" cover. /volumes/ still has all
// three, so the stripped results of a page are filled with one /volumes/?filter=id: call. Returns
// filled = false when that call failed, so the page isn't cached and the next look tries again.
async function fillStrippedVolumes(volumes: ComicVineVolume[], apiKey: string): Promise<{ volumes: ComicVineVolume[]; filled: boolean }> {
  const stripped = volumes.filter(v => v?.id && !v.publisher);
  if (stripped.length === 0) return { volumes, filled: true };
  try {
    const res = await cachedCvGet(`${BASE_URL}/volumes/`, {
      params: {
        api_key: apiKey, format: 'json', filter: `id:${stripped.map(v => v.id).join('|')}`,
        field_list: 'id,publisher,count_of_issues,image', limit: 100
      },
      headers: { 'User-Agent': 'Omnibus/1.0' },
      timeout: 8000
    });
    // status_code 1 = OK; anything else (100 bad key, 104 filter error, 107 rate limited) is an error answer.
    if (Number(res.data?.status_code) !== 1 || !Array.isArray(res.data.results)) return { volumes, filled: false };
    const byId = new Map<number, Partial<ComicVineVolume>>(res.data.results.map((f: ComicVineVolume) => [f.id, f]));
    return {
      filled: true,
      volumes: volumes.map(v => {
        const f = byId.get(v.id);
        if (!f) return v;
        return { ...v, publisher: f.publisher ?? v.publisher, count_of_issues: f.count_of_issues ?? v.count_of_issues, image: f.image ?? v.image };
      })
    };
  } catch (e) {
    Logger.log(`[Search] Couldn't fill ComicVine's stripped search results from /volumes/: ${getErrorMessage(e)}`, 'warn');
    return { volumes, filled: false };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawQuery = searchParams.get('q');
  let provider = searchParams.get('provider');
  
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = 40;
  // covers=none: an automated caller (Smart Match's Auto-Scan) that doesn't show every result's cover.
  // A Metron cover costs one request per result, so only a search someone is looking at asks for them.
  const wantCovers = searchParams.get('covers') !== 'none';

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
    // v4: v3 pages cached while ComicVine's search was stripped hold "Other" / 0 issues / no cover.
    const cacheKey = `search_v4_${provider}_${rawQuery.toLowerCase().replace(/[^a-z0-9]/g, '_')}_p${page}${wantCovers ? '' : '_nocovers'}`;
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
    // A page whose covers were skipped (Metron busy) isn't cached, so the next look fills them in.
    let cacheable = true;

    if (provider === 'METRON') {
        const metron = new MetronProvider();
        // The shared Metron client counts every request it actually sends (cache hits aren't calls).
        const mdResults = await metron.searchSeries(query, page, { covers: wantCovers });
        cacheable = !mdResults.some(r => r.coverPending);

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

        const response = await cachedCvGet(`${BASE_URL}/search/`, {
          params: {
            // ComicVine's search tokenizer chokes on slashes ("Hack/Slash" returns nothing while
            // "Hack Slash" matches — discussion #177); fold them for CV only. Metron's ?name=
            // icontains filter needs the RAW name, so the fold is scoped to this branch.
            api_key: CV_API_KEY, format: 'json', query: query.replace(/[\/\\]/g, ' ').replace(/\s+/g, ' ').trim(), resources: 'volume', limit: limit, page: page,
            field_list: 'id,name,start_year,publisher,count_of_issues,image,deck,description'
          },
          headers: { 'User-Agent': 'Omnibus/1.0' }
        });

        if (!response.data || !Array.isArray(response.data.results)) {
            return NextResponse.json({ results: [], hasMore: false });
        }

        const fill = await fillStrippedVolumes(response.data.results, CV_API_KEY);
        cacheable = fill.filled;

        let results = fill.volumes.map((vol: ComicVineVolume) => {
          let desc = vol.deck;
          if (!desc && vol.description) {
             desc = vol.description.replace(/<[^>]*>?/gm, '').trim();
             if (desc.length > 500) desc = desc.substring(0, 500) + '...';
          }

          const rawImage = vol.image?.medium_url || vol.image?.small_url || vol.image?.super_url || null;

          return {
            id: vol.id, name: vol.name, year: vol.start_year || null,
            // 'Unknown', not 'Other': the request route and the request dialog look up an Unknown publisher.
            publisher: vol.publisher?.name || 'Unknown', count: vol.count_of_issues || 0,
            image: rawImage ? `/api/library/cover?path=${encodeURIComponent(rawImage)}` : null,
            description: desc || "No description available.",
            metadataSource: 'COMICVINE'
          };
        });

        if (blockedForeignPublishers.length > 0) {
            results = results.filter(r => {
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
    if (cacheable) {
        await prisma.systemSetting.upsert({
            where: { key: cacheKey },
            update: { value: JSON.stringify({ timestamp: Date.now(), results: finalResults, hasMore }) },
            create: { key: cacheKey, value: JSON.stringify({ timestamp: Date.now(), results: finalResults, hasMore }) }
        });
    }

    return NextResponse.json({ results: finalResults, hasMore });

  } catch (error) {
    Logger.log(`API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
}