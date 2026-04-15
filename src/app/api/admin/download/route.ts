import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(req: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    const body = await req.json();
    const { guid, downloadUrl, title, protocol, requestId, infoHash } = body; 

    if (!requestId) return NextResponse.json({ error: 'Request ID missing' }, { status: 400 });

    const urlToDownload = downloadUrl || guid;
    if (!urlToDownload) return NextResponse.json({ error: 'Download URL missing' }, { status: 400 });

    // Fetch the download clients configured by the admin
    const clients = await prisma.downloadClient.findMany();
    if (clients.length === 0) {
        return NextResponse.json({ error: 'No download client configured in Settings.' }, { status: 400 });
    }

    // Try to match the client by protocol (torrent vs usenet), otherwise fallback to the first available client
    const client = clients.find(c => c.protocol.toLowerCase() === protocol.toLowerCase()) || clients[0];

    // Send the link to the unified DownloadService
    await DownloadService.addDownload(client, urlToDownload, title, 0, 0);

    const downloadHash = infoHash || guid;

    await prisma.request.update({
      where: { id: requestId },
      data: {
        status: 'DOWNLOADING',
        downloadLink: downloadHash || "PENDING_MATCH", 
        progress: 0
      }
    });

    if (userId) {
        await AuditLogger.log('ADMIN_SENT_TO_CLIENT', { title, protocol }, userId);
    }

    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    Logger.log(`Download Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: 'Failed to send to client' }, { status: 500 });
  }
}