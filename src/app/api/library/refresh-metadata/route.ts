import { NextResponse } from 'next/server';
import { syncSeriesMetadata } from '@/lib/metadata-fetcher';

export async function POST(request: Request) {
  try {
    const { cvId, folderPath } = await request.json();
    
    if (!cvId) return NextResponse.json({ error: "Missing cvId" }, { status: 400 });

    await syncSeriesMetadata(parseInt(cvId), folderPath);
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log("Refresh Metadata Failed:", error, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}