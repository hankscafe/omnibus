import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { parseComicVineCredits } from '@/lib/utils';
import { sanitizeDescription } from '@/lib/utils/sanitize'; //

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = await getToken({ req: request as any });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const type = searchParams.get('type') || 'issue'; 
  const volId = searchParams.get('volId');
  const isIssue = type === 'issue';

  if (!id) return NextResponse.json({ error: 'Missing ID' }, { status: 400 });

  const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
  if (!setting?.value) return NextResponse.json({ error: 'Missing API Key' }, { status: 500 });

  try {
    const endpoint = isIssue ? `issue/4000-${id}` : `volume/4050-${id}`;
    const res = await axios.get(`https://comicvine.gamespot.com/api/${endpoint}/`, {
        params: { api_key: setting.value, format: 'json', field_list: 'id,name,issue_number,start_year,cover_date,store_date,image,deck,description,publisher,volume,person_credits,character_credits,concepts,story_arc_credits,site_detail_url' },
        headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    
    const issueData = res.data.results;
    if (!issueData) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

    // SECURITY FIX: Sanitize raw metadata before returning
    const rawHtml = issueData.description || issueData.deck || "";
    const cleanHtml = sanitizeDescription(rawHtml);

    const { writers, artists, characters, genres, storyArcs } = parseComicVineCredits(issueData.person_credits);

    return NextResponse.json({
      id: issueData.id,
      name: issueData.name || 'Unknown',
      publisher: issueData.publisher?.name || 'Unknown', 
      image: issueData.image?.medium_url,
      description: cleanHtml.replace(/<[^>]*>?/gm, '').trim().substring(0, 800), // Clean plain text for UI previews
      writers: writers.slice(0, 5),
      artists: artists.slice(0, 5),
      characters: characters.slice(0, 15),
      genres,
      storyArcs,
      htmlDescription: cleanHtml // Full sanitized HTML for display
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch details' }, { status: 500 });
  }
}