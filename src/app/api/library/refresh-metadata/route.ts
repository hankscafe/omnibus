import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    const { cvId, metadataId, metadataSource, folderPath } = await request.json();
    
    const targetId = metadataId || (cvId ? cvId.toString() : null);
    const targetSource = metadataSource || 'COMICVINE';

    if (!targetId) return NextResponse.json({ error: "Missing metadata ID" }, { status: 400 });

    const series = await prisma.series.findFirst({
        where: { metadataId: targetId, metadataSource: targetSource }
    });
    
    if (!series) {
        return NextResponse.json({ error: "Series not found in database." }, { status: 404 });
    }

    // Safely hand the long-running task to BullMQ
    await omnibusQueue.add('METADATA_SYNC', { 
        type: 'METADATA_SYNC', 
        seriesIds: [series.id] 
    }, {
        jobId: `METADATA_SYNC_MANUAL_${series.id}_${Date.now()}`
    });
    
    Logger.log(`[Metadata] Manual refresh for "${series.name}" queued in background.`, 'info');
    
    return NextResponse.json({ success: true, message: "Metadata sync queued." });
  } catch (error: unknown) {
    Logger.log(`Refresh Metadata Failed: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}