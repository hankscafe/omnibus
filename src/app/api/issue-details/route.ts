// src/app/api/issue-details/route.ts
import { NextResponse } from 'next/server';
import { apiClient as axios } from '@/lib/api-client';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { parseComicVineCredits } from '@/lib/utils';
import { sanitizeDescription } from '@/lib/utils/sanitize';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { logApiUsage } from '@/lib/utils/system-flags';
import { MetronProvider } from '@/lib/metadata/providers/metron';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = await getToken({ req: request as any });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'issue'; 
  const provider = searchParams.get('provider') || 'COMICVINE';
  const isIssue = type === 'issue';

  if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });

  // --- FIX: Bumped cache key to v11 to flush generically named issues ("Issue #3") ---
  const cacheKey = `meta_details_v12_${type}_${provider}_${id}`;
  const cachedData = await prisma.systemSetting.findUnique({ where: { key: cacheKey } });
  
  if (cachedData?.value) {
      try {
          const parsedCache = JSON.parse(cachedData.value);
          if (Date.now() - parsedCache.timestamp < 24 * 60 * 60 * 1000) {
              return NextResponse.json(parsedCache.data);
          }
      } catch(e) {}
  }

  try {
    let finalPayload;

    if (provider === 'METRON') {
        const metron = new MetronProvider();
        if (isIssue) {
            const details = await metron.getIssueDetails(id);
            
            let issueTitle = details.name ? String(details.name) : ""; 
            let volName = details.seriesName;
            let issueDesc = details.description;
            const issueNum = details.issueNumber;
            
            if ((!volName || volName === 'Unknown Series' || !issueDesc) && details.seriesId) {
                try {
                    const seriesFallback = await metron.getSeriesDetails(details.seriesId.toString());
                    if (seriesFallback) {
                        if (!volName || volName === 'Unknown Series') volName = seriesFallback.name;
                        if (!issueDesc) issueDesc = seriesFallback.description;
                    }
                } catch(e) {}
            }
            if (!volName) volName = 'Unknown Series';
            
            let finalName = `${volName} #${issueNum}`;
            
            // --- FIX: Ensure the API strictly ignores the generic "Issue #3" override ---
            const isGeneric = issueTitle.match(/^Issue\s*#?\s*-?\d+$/i) !== null;
            
            if (issueTitle && issueTitle !== volName && !issueTitle.includes(`#${issueNum}`) && !isGeneric) {
                finalName += `: ${issueTitle}`;
            } else if (issueTitle && issueTitle.includes(`#${issueNum}`) && !isGeneric) {
                finalName = issueTitle;
            }
            
            finalPayload = {
                id: parseInt(details.sourceId || "0"), 
                name: finalName,
                volumeName: volName, 
                volumeId: details.seriesId || null, 
                publisher: details.publisher || 'Unknown', 
                image: details.coverUrl,
                year: details.releaseDate ? details.releaseDate.split('-')[0] : '????',
                description: issueDesc || "No description available.",
                siteUrl: `https://metron.cloud/issue/${details.sourceId}/`, 
                writers: details.writers || [],
                artists: details.artists || [],
                coverArtists: details.coverArtists || [],
                colorists: details.colorists || [],
                letterers: details.letterers || [],
                characters: details.characters || [],
                teams: details.teams || [],
                locations: details.locations || [],
                genres: [],
                storyArcs: details.storyArcs || [],
                htmlDescription: details.description || ""
            };
        } else {
            const details = await metron.getSeriesDetails(id);
            finalPayload = {
                id: parseInt(details?.sourceId || "0"), 
                name: details?.name,
                volumeName: details?.name,
                volumeId: parseInt(details?.sourceId || "0"),
                publisher: details?.publisher,
                image: details?.coverUrl,
                year: details?.year?.toString() || '????',
                description: details?.description || "No description available.",
                siteUrl: `https://metron.cloud/series/${details?.sourceId}/`, 
                // Bypass strict TypeScript checking for these dynamic API fields
                count: (details as any)?.issueCount || (details as any)?.count_of_issues || "?",
                issues: (details as any)?.issues || [],
                writers: [], artists: [], coverArtists: [], colorists: [], letterers: [],
                characters: [], teams: [], locations: [], genres: [], storyArcs: [],
                htmlDescription: details?.description || ""
            };
        }
    } else {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        const cvKey = setting?.value;
        if (!cvKey || cvKey === '********') return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });

        const endpoint = isIssue ? `issue/4000-${id}` : `volume/4050-${id}`;
        
        const baseFields = 'id,name,issue_number,start_year,cover_date,store_date,image,deck,description,publisher,volume,person_credits,character_credits,concepts,story_arc_credits,team_credits,location_credits,site_detail_url';
        
        // Only ask for issue lists if we are looking up a Volume!
        const fieldList = isIssue ? baseFields : `${baseFields},count_of_issues,issues`;

        const res = await axios.get(`https://comicvine.gamespot.com/api/${endpoint}/`, {
            params: { 
                api_key: cvKey, 
                format: 'json', 
                // Added count_of_issues and issues to the end
                field_list: fieldList
            }
        });
        
        await logApiUsage('comicvine', `/${isIssue ? 'issue' : 'volume'}`);
        
        const issueData = res.data.results;
        if (!issueData) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

        const rawHtml = issueData.description || issueData.deck || "";
        const cleanHtml = sanitizeDescription(rawHtml);
        const { writers, artists, coverArtists, colorists, letterers, characters, genres, storyArcs, teams, locations } = parseComicVineCredits(
            issueData.person_credits, 
            issueData.character_credits, 
            issueData.concepts, 
            issueData.story_arc_credits,
            issueData.team_credits,
            issueData.location_credits
        );

        const issueTitle = issueData.name;
        const volName = isIssue ? issueData.volume?.name : issueData.name;
        const issueNum = issueData.issue_number;
        
        let finalName = volName;
        if (isIssue) {
            finalName = `${volName} #${issueNum}`;
            if (issueTitle && issueTitle !== volName && !issueTitle.includes(`#${issueNum}`)) {
                finalName += `: ${issueTitle}`;
            } else if (issueTitle && issueTitle.includes(`#${issueNum}`)) {
                finalName = issueTitle;
            }
        }

        finalPayload = {
          id: issueData.id,
          name: finalName || null, 
          volumeName: volName || 'Unknown',
          volumeId: isIssue ? issueData.volume?.id : issueData.id,
          publisher: issueData.publisher?.name || issueData.volume?.publisher?.name || 'Unknown', 
          image: issueData.image?.medium_url,
          year: (issueData.start_year || issueData.cover_date || "").split('-')[0] || '????',
          description: cleanHtml.replace(/<[^>]*>?/gm, '').trim().substring(0, 800),
          count: issueData.count_of_issues || "?",
          issues: issueData.issues || [],
          writers: writers.slice(0, 10),
          artists: artists.slice(0, 10),
          coverArtists: coverArtists.slice(0, 10),
          colorists: colorists.slice(0, 10),
          letterers: letterers.slice(0, 5),
          characters: characters.slice(0, 20),
          teams: teams.slice(0, 10),
          locations: locations.slice(0, 10),
          genres,
          storyArcs,
          htmlDescription: cleanHtml
        };
    }

    await prisma.systemSetting.upsert({
        where: { key: cacheKey },
        update: { value: JSON.stringify({ timestamp: Date.now(), data: finalPayload }) },
        create: { key: cacheKey, value: JSON.stringify({ timestamp: Date.now(), data: finalPayload }) }
    });

    return NextResponse.json(finalPayload);
  } catch (error: unknown) {
    Logger.log(`[Issue Details API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch details' }, { status: 500 });
  }
}