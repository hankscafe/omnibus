import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { guid, title, protocol, requestId, infoHash } = body; 

    if (!requestId) return NextResponse.json({ error: 'Request ID missing' }, { status: 400 });

    let downloadHash = "";

    if (protocol === 'torrent') {
      // Pass the infoHash if we have it
      downloadHash = await DownloadService.addMagnet(guid, infoHash);
    } 
    else if (protocol === 'usenet') {
      downloadHash = await DownloadService.addNzb(guid, title);
    }

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'DOWNLOADING',
        downloadHash: downloadHash || "PENDING_MATCH", // Fallback if no hash found yet
        progress: 0
      }
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("Download Error:", error);
    return NextResponse.json({ error: 'Failed to send to client' }, { status: 500 });
  }
}