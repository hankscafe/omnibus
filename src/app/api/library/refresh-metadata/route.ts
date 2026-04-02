import { NextResponse } from 'next/server';
import { syncSeriesMetadata } from '@/lib/metadata-fetcher';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    const { cvId, metadataId, metadataSource, folderPath } = await request.json();
    
    const targetId = metadataId || (cvId ? cvId.toString() : null);
    const targetSource = metadataSource || 'COMICVINE';

    if (!targetId) return NextResponse.json({ error: "Missing metadata ID" }, { status: 400 });

    await syncSeriesMetadata(targetId, folderPath, targetSource);
    
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`Refresh Metadata Failed: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}