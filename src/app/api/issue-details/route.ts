// src/app/api/issue-details/route.ts
import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { parseComicVineCredits } from '@/lib/utils';
import { sanitizeDescription } from '@/lib/utils/sanitize';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { logApiUsage } from '@/lib/utils/system-flags';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = await getToken({ req: request as any });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'issue'; 
  const isIssue = type === 'issue';

  if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });

  const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
  let cvKey = setting?.value;
  if (!cvKey || cvKey === '********') {
      const realKey = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
      cvKey = realKey?.value;
  }

  if (!cvKey) return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });

  try {
    const endpoint = isIssue ? `issue/4000-${id}` : `volume/4050-${id}`;
    const res = await axios.get(`https://comicvine.gamespot.com/api/${endpoint}/`, {
        params: { 
            api_key: cvKey, 
            format: 'json', 
            field_list: 'id,name,issue_number,start_year,cover_date,store_date,image,deck,description,publisher,volume,person_credits,character_credits,concepts,story_arc_credits,team_credits,location_credits,site_detail_url' 
        },
        headers: { 'User-Agent': 'Omnibus/1.0' }
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

    return NextResponse.json({
      id: issueData.id,
      name: issueData.name || null, 
      volumeName: isIssue ? issueData.volume?.name : issueData.name, 
      volumeId: isIssue ? issueData.volume?.id : issueData.id,
      publisher: issueData.publisher?.name || issueData.volume?.publisher?.name || 'Unknown', 
      image: issueData.image?.medium_url,
      year: (issueData.start_year || issueData.cover_date || "").split('-')[0] || '????',
      description: cleanHtml.replace(/<[^>]*>?/gm, '').trim().substring(0, 800),
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
    });
  } catch (error: unknown) {
    Logger.log(`[Issue Details API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch details' }, { status: 500 });
  }
}