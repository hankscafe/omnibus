import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { SearchEngine } from '@/lib/search-engine';

export async function POST(request: Request) {
  try {
    const { requestId } = await request.json();

    const req = await prisma.request.findUnique({
        where: { id: requestId }
    });

    if (!req) return NextResponse.json({ error: "Request not found" }, { status: 404 });

    // Construct Search Query
    // e.g., "Batman 050 2016" or "Saga Vol 1"
    let query = "";
    
    if (req.issueId) {
        // Issue Search
        // Format: "Series Name IssueNumber Year" -> "Batman 050 2016"
        // Pad issue number to 3 digits helps matches often
        const issueNum = req.name.match(/#(\d+)/)?.[1] || "";
        const paddedNum = issueNum.padStart(3, '0');
        const cleanName = req.seriesName.replace(/[^\w\s]/g, ''); // Remove special chars
        
        query = `${cleanName} ${paddedNum} ${req.year}`;
    } else {
        // Volume/Series Search
        // Ideally we search for "Series Name Year Pack" or similar, 
        // but for now let's just search the name and year
        query = `${req.name} ${req.year}`;
    }

    const result = await SearchEngine.performSmartSearch(query);

    if (result.success) {
        // Update Status
        await prisma.request.update({
            where: { id: requestId },
            data: { status: 'DOWNLOADING' }
        });
        return NextResponse.json({ success: true, message: `Started download: ${result.release}` });
    } else {
        return NextResponse.json({ success: false, error: result.message });
    }

  } catch (error: any) {
    Logger.log("Force Search Error:", error, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}