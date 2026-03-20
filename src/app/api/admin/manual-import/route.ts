import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Importer } from '@/lib/importer';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { requestId, torrentName, torrentId } = await request.json();

    if (!requestId) {
      return NextResponse.json({ error: "Request ID required" }, { status: 400 });
    }

    // --- FIX: Update the request with the actual unmatched torrent info ---
    if (torrentName && torrentId) {
         await prisma.request.update({
             where: { id: requestId },
             data: {
                 activeDownloadName: torrentName,
                 downloadLink: torrentId
             }
         });
    }

    Logger.log(`[Admin API] Manual import triggered for Request: ${requestId}`, 'info');

    // Call the unified importer service
    const success = await Importer.importRequest(requestId);

    if (success) {
      return NextResponse.json({ success: true, message: "Import successful" });
    } else {
      return NextResponse.json({ 
        success: false, 
        error: "Import failed. Check system logs for path or mapping errors." 
      }, { status: 500 });
    }

  } catch (error: unknown) {
    Logger.log(`[Admin API] Manual Import CRASHED: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}