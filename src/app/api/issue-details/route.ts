import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { parseComicVineCredits } from '@/lib/utils';

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
    // 1. FAST LOCAL CHECK: Do we already know the Publisher from our Library?
    let localPublisher = null;
    if (volId && volId !== 'undefined') {
        const localSeries = await prisma.series.findFirst({ 
            where: { cvId: parseInt(volId) },
            select: { publisher: true }
        });
        if (localSeries?.publisher) localPublisher = localSeries.publisher;
    }

    const endpoint = isIssue ? `issue/4000-${id}` : `volume/4050-${id}`;
    
    // 2. Fetch the base Issue data
    const res = await axios.get(`https://comicvine.gamespot.com/api/${endpoint}/`, {
        params: { api_key: setting.value, format: 'json', field_list: 'id,name,issue_number,start_year,cover_date,store_date,image,deck,description,publisher,volume,person_credits,character_credits,site_detail_url' },
        headers: { 'User-Agent': 'Omnibus/1.0' }
    });
    
    const issueData = res.data.results;
    if (!issueData) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

    let person_credits = issueData.person_credits || [];
    let character_credits = issueData.character_credits || [];
    let htmlDescription = issueData.description || issueData.deck || null;
    let publisher = localPublisher || issueData.publisher?.name || issueData.volume?.publisher?.name || null;

    // 3. THE RATE LIMIT DEFEATER (Sequential Fallback)
    // If we are missing the publisher, OR missing deep data, politely fetch the Volume.
    if (isIssue && (!publisher || !person_credits.length || !character_credits.length || !htmlDescription) && issueData.volume?.api_detail_url) {
        try {
            await new Promise(resolve => setTimeout(resolve, 1100)); // Respect 1 req/sec limit
            const volRes = await axios.get(issueData.volume.api_detail_url, {
                params: { api_key: setting.value, format: 'json', field_list: 'publisher,person_credits,character_credits,description,deck' },
                headers: { 'User-Agent': 'Omnibus/1.0' }
            });
            const vData = volRes.data.results;
            
            if (!person_credits.length) person_credits = vData.person_credits || [];
            if (!character_credits.length) character_credits = vData.character_credits || [];
            if (!htmlDescription) htmlDescription = vData.description || vData.deck || null;
            if (!publisher) publisher = vData.publisher?.name || null;
        } catch(e) {}
    }

    // Use the centralized metadata parser
    const { writers, artists, characters } = parseComicVineCredits(person_credits, character_credits);

    let displayName = issueData.name;
    if (isIssue && issueData.volume?.name) {
        displayName = `${issueData.volume.name} #${issueData.issue_number || ''}`;
    }

    return NextResponse.json({
      id: issueData.id,
      volumeId: issueData.volume?.id || issueData.id,
      name: displayName || 'Unknown',
      year: isIssue ? (issueData.cover_date?.split('-')[0] || issueData.store_date?.split('-')[0] || '????') : (issueData.start_year || '????'),
      publisher: publisher || 'Unknown', 
      image: issueData.image?.medium_url || issueData.image?.super_url || issueData.image?.small_url || null,
      description: (htmlDescription || "").replace(/<[^>]*>?/gm, '').trim().substring(0, 800),
      writers: writers.slice(0, 5),
      artists: artists.slice(0, 5),
      characters: characters.slice(0, 15),
      siteUrl: issueData.site_detail_url,
      rawImage: issueData.image || null,
      person_credits,
      character_credits,
      htmlDescription: htmlDescription || "No synopsis available."
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch details' }, { status: 500 });
  }
}