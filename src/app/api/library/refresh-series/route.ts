import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';

export async function POST(request: Request) {
  try {
    const { cvId, folderPath } = await request.json();
    if (!cvId) return NextResponse.json({ error: "Missing ComicVine ID" }, { status: 400 });

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    const cvApiKey = setting?.value;

    if (!cvApiKey) return NextResponse.json({ error: "Missing ComicVine API Key" }, { status: 400 });

    // 1. Fetch fresh Volume data from ComicVine
    const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
        params: { api_key: cvApiKey, format: 'json', field_list: 'publisher,name,start_year,description,image' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000
    });

    const volData = cvVolRes.data?.results;
    if (!volData) return NextResponse.json({ error: "Could not fetch data from ComicVine" }, { status: 404 });

    // 2. Update local database with fresh data
    const publisherName = volData.publisher?.name || "Unknown";
    
    await prisma.series.updateMany({
        where: { cvId: parseInt(cvId) },
        data: { 
            name: volData.name, 
            year: parseInt(volData.start_year) || 0, 
            publisher: publisherName 
        }
    });

    // 3. Trigger a background cover refresh just in case
    if (folderPath) {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
        fetch(`${baseUrl}/api/library/refresh-metadata`, {
            method: 'POST',
            body: JSON.stringify({ cvId: parseInt(cvId), folderPath })
        }).catch(() => {});
    }

    return NextResponse.json({ success: true, message: "Metadata Refreshed!" });

  } catch (error: any) {
    console.error("Refresh Error:", error.message);
    return NextResponse.json({ error: "Failed to refresh metadata" }, { status: 500 });
  }
}