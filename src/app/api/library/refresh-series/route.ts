import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { MetronProvider } from '@/lib/metadata/providers/metron';

export async function POST(request: Request) {
  try {
    const { cvId, metadataId, metadataSource, folderPath } = await request.json();
    
    // Normalize IDs and Sources
    const targetId = metadataId || (cvId ? cvId.toString() : null);
    const targetSource = metadataSource || 'COMICVINE';

    if (!targetId) return NextResponse.json({ error: "Missing metadata ID" }, { status: 400 });

    let seriesName, seriesYear, publisherName;

    if (targetSource === 'METRON') {
        const metron = new MetronProvider();
        const details = await metron.getSeriesDetails(targetId);
        
        if (!details) {
             return NextResponse.json({ error: "Could not fetch data from Metron" }, { status: 404 });
        }
        
        seriesName = details.name;
        seriesYear = details.year;
        publisherName = details.publisher;
    } else {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        const cvApiKey = setting?.value;

        if (!cvApiKey) return NextResponse.json({ error: "Missing ComicVine API Key" }, { status: 400 });

        const cvVolRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${targetId}/`, {
            params: { api_key: cvApiKey, format: 'json', field_list: 'publisher,name,start_year,description,image' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 10000
        });

        const volData = cvVolRes.data?.results;
        if (!volData) return NextResponse.json({ error: "Could not fetch data from ComicVine" }, { status: 404 });

        seriesName = volData.name;
        seriesYear = parseInt(volData.start_year) || 0;
        publisherName = volData.publisher?.name || "Unknown";
    }

    // Update the basic series data using the correct source flag
    await prisma.series.updateMany({
        where: { metadataId: targetId.toString(), metadataSource: targetSource },
        data: { 
            name: seriesName, 
            year: seriesYear, 
            publisher: publisherName 
        }
    });

    // Pass the correct Source downstream to the deep-sync metadata fetcher
    if (folderPath) {
        const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
        fetch(`${baseUrl}/api/library/refresh-metadata`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                metadataId: targetId, 
                metadataSource: targetSource, 
                folderPath 
            })
        }).catch(() => {});
    }

    return NextResponse.json({ success: true, message: "Metadata Refreshed!" });

  } catch (error: unknown) {
    Logger.log(`Refresh Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Failed to refresh metadata" }, { status: 500 });
  }
}