import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { guid, title, protocol, requestId, infoHash } = body; 

    if (!requestId) return NextResponse.json({ error: 'Request ID missing' }, { status: 400 });

    let downloadHash = "";

    if (protocol === 'torrent') {
      // Pass the infoHash if we have it
      // @ts-ignore
      downloadHash = await DownloadService.addMagnet(guid, infoHash);
    } 
    else if (protocol === 'usenet') {
      // @ts-ignore
      downloadHash = await DownloadService.addNzb(guid, title);
    }

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'DOWNLOADING',
        downloadLink: downloadHash || "PENDING_MATCH", // Fallback if no hash found yet
        progress: 0
      }
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    Logger.log(`Download Error: ${getErrorMessage(error)}`, 'error');

    return NextResponse.json({ error: 'Failed to send to client' }, { status: 500 });
  }
}