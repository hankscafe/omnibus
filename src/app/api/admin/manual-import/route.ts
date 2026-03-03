import { NextResponse } from 'next/server';
import { Importer } from '@/lib/importer';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { requestId } = await request.json();

    if (!requestId) {
      return NextResponse.json({ error: "Request ID required" }, { status: 400 });
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

  } catch (error: any) {
    Logger.log(`[Admin API] Manual Import CRASHED: ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}