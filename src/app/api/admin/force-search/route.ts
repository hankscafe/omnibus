import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { SearchEngine } from '@/lib/search-engine';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    const body = (await request.json()) as any;
    const requestId = body.id || body.requestId;

    const dbReq = await prisma.request.findUnique({
        where: { id: requestId }
    });

    if (!dbReq) return NextResponse.json({ error: "Request not found" }, { status: 404 });

    let query = "";
    if (body.issueId) {
        const issueNum = body.name?.match(/#(\d+)/)?.[1] || "";
        const paddedNum = issueNum.padStart(3, '0');
        const cleanName = body.seriesName?.replace(/[^\w\s]/g, '') || ""; 
        query = `${cleanName} ${paddedNum} ${body.year}`;
    } else {
        query = `${body.name} ${body.year}`;
    }

    // Resolve manga-vs-comics from the request's series so a forced download is filed under the right category.
    const fsSeries = await prisma.series.findFirst({ where: { metadataId: dbReq.volumeId, metadataSource: dbReq.metadataSource }, select: { isManga: true } });
    const result = await SearchEngine.performSmartSearch(query, fsSeries?.isManga ?? false);

    if (result.success) {
        await prisma.request.update({
            where: { id: requestId },
            data: { 
                status: 'DOWNLOADING',
                downloadLink: result.downloadLink,
                activeDownloadName: result.release
            }
        });
        
        if (userId) {
            await AuditLogger.log('ADMIN_FORCE_SEARCH', { query, release: result.release }, userId);
        }

        return NextResponse.json({ success: true, message: `Started download: ${result.release}` });
    } else {
        return NextResponse.json({ success: false, error: result.message });
    }

  } catch (error: unknown) {
    Logger.log(`Force Search Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}