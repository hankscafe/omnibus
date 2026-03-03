import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // 1. Authenticate Request
  // Supports either passing it as a direct header (X-Api-Key) or a Bearer token
  const rawAuthHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-api-key') || (rawAuthHeader?.startsWith('Bearer ') ? rawAuthHeader.split('Bearer ')[1] : null);
  
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'omnibus_api_key' } });
  const validKey = setting?.value;

  if (!validKey || apiKeyHeader !== validKey) {
    return NextResponse.json({ error: 'Unauthorized. Invalid API Key.' }, { status: 401 });
  }

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 2. Fetch Stats from DB
    const [totalSeries, totalIssues, totalRequests, completed30d, failed30d, totalUsers] = await prisma.$transaction([
      prisma.series.count(),
      prisma.issue.count(),
      prisma.request.count(),
      prisma.request.count({ where: { status: 'IMPORTED', createdAt: { gte: thirtyDaysAgo } } }),
      prisma.request.count({ where: { status: { in: ['FAILED', 'ERROR'] }, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.user.count()
    ]);

    // 3. Fetch Data from Download Clients
    let activeDownloads: any[] = [];
    let systemHealthy = true;

    try {
        activeDownloads = await DownloadService.getAllActiveDownloads();
    } catch (e) {
        systemHealthy = false;
    }

    // 4. Return clean JSON structure
    return NextResponse.json({
      success: true,
      data: {
        systemHealth: systemHealthy ? 'Healthy' : 'Degraded (Download Client Issue)',
        totalSeries,
        totalIssues,
        totalRequests,
        completed30d,
        failed30d,
        totalUsers,
        activeDownloads: activeDownloads.length,
        queue: activeDownloads // Returns the array of what is currently downloading so external tools can display it
      }
    });

  } catch (error: any) {
    return NextResponse.json({ error: 'Internal Server Error', details: error.message }, { status: 500 });
  }
}