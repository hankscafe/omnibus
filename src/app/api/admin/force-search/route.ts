import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { SearchEngine } from '@/lib/search-engine';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    // 1. Parse JSON body safely
    const body = (await request.json()) as any;
    const requestId = body.id || body.requestId;

    // 2. Fetch the actual Prisma Request model
    const dbReq = await prisma.request.findUnique({
        where: { id: requestId }
    });

    if (!dbReq) return NextResponse.json({ error: "Request not found" }, { status: 404 });

    // 3. Construct Search Query using the JSON body (which holds the extra fields)
    let query = "";
    
    if (body.issueId) {
        const issueNum = body.name?.match(/#(\d+)/)?.[1] || "";
        const paddedNum = issueNum.padStart(3, '0');
        const cleanName = body.seriesName?.replace(/[^\w\s]/g, '') || ""; 
        
        query = `${cleanName} ${paddedNum} ${body.year}`;
    } else {
        query = `${body.name} ${body.year}`;
    }

    const result = await SearchEngine.performSmartSearch(query);

    if (result.success) {
        await prisma.request.update({
            where: { id: requestId },
            data: { status: 'DOWNLOADING' }
        });
        return NextResponse.json({ success: true, message: `Started download: ${result.release}` });
    } else {
        return NextResponse.json({ success: false, error: result.message });
    }

  } catch (error: unknown) {
    Logger.log(`Force Search Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}