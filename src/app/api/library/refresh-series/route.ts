import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    const { cvId, folderPath } = await request.json();
    if (!cvId) return NextResponse.json({ error: "Missing ComicVine ID" }, { status: 400 });

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    const cvApiKey = setting?.value;

    if (!cvApiKey) return NextResponse.json({ error: "Missing ComicVine API Key" }, { status: 400 });

    const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
        params: { api_key: cvApiKey, format: 'json', field_list: 'publisher,name,start_year,description,image' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 10000
    });

    const volData = cvVolRes.data?.results;
    if (!volData) return NextResponse.json({ error: "Could not fetch data from ComicVine" }, { status: 404 });

    const publisherName = volData.publisher?.name || "Unknown";
    
    await prisma.series.updateMany({
        where: { metadataId: cvId.toString(), metadataSource: 'COMICVINE' },
        data: { 
            name: volData.name, 
            year: parseInt(volData.start_year) || 0, 
            publisher: publisherName 
        }
    });

    if (folderPath) {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
        fetch(`${baseUrl}/api/library/refresh-metadata`, {
            method: 'POST',
            body: JSON.stringify({ cvId: parseInt(cvId), folderPath })
        }).catch(() => {});
    }

    return NextResponse.json({ success: true, message: "Metadata Refreshed!" });

  } catch (error: unknown) {
    Logger.log(`Refresh Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Failed to refresh metadata" }, { status: 500 });
  }
}