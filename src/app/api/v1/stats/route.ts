import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';

export const dynamic = 'force-dynamic';

function isNewerVersion(latest: string, current: string): boolean {
    const cleanLatest = latest.replace(/^v/, '');
    const cleanCurrent = current.replace(/^v/, '');
    if (cleanLatest === cleanCurrent) return false;
    const parse = (v: string) => {
        const [main, pre] = v.split('-');
        return { nums: main.split('.').map(n => parseInt(n, 10) || 0), preParts: pre ? pre.split('.') : [] };
    };
    const l = parse(cleanLatest);
    const c = parse(cleanCurrent);
    for (let i = 0; i < 3; i++) {
        const lNum = l.nums[i] || 0;
        const cNum = c.nums[i] || 0;
        if (lNum > cNum) return true;
        if (lNum < cNum) return false;
    }
    if (l.preParts.length === 0 && c.preParts.length > 0) return true; 
    if (l.preParts.length > 0 && c.preParts.length === 0) return false; 
    for (let i = 0; i < Math.max(l.preParts.length, c.preParts.length); i++) {
        const lPart = l.preParts[i];
        const cPart = c.preParts[i];
        if (lPart === undefined) return false; 
        if (cPart === undefined) return true;
        const lIsNum = !isNaN(Number(lPart));
        const cIsNum = !isNaN(Number(cPart));
        if (lIsNum && cIsNum) {
            if (Number(lPart) > Number(cPart)) return true;
            if (Number(lPart) < Number(cPart)) return false;
        } else if (!lIsNum && !cIsNum) {
            if (lPart > cPart) return true;
            if (lPart < cPart) return false;
        } else { return !lIsNum; }
    }
    return false;
}

export async function GET(req: NextRequest) {
  // 1. Hyper-Resilient Auth Checking
  const authHeader = req.headers.get('authorization') || '';
  const tokenFromBearer = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '').trim() : null;
  const apiKeyHeader = req.headers.get('x-api-key')?.trim();
  const apiKeyQuery = req.nextUrl.searchParams.get('apiKey')?.trim();

  // Accept the key from literally anywhere
  const providedKey = apiKeyHeader || tokenFromBearer || apiKeyQuery;

  const setting = await prisma.systemSetting.findUnique({ where: { key: 'omnibus_api_key' } });
  const validKey = setting?.value?.trim();

  if (!validKey || providedKey !== validKey) {
    console.log(`[Stats API] Auth Failed! Received: '${providedKey}' | Expected: '${validKey}'`);
    return NextResponse.json({ error: 'Unauthorized. Invalid API Key.' }, { status: 401 });
  }

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totalSeries, totalIssues, totalRequests, completed30d, failed30d, totalUsers] = await prisma.$transaction([
      prisma.series.count(), prisma.issue.count(), prisma.request.count(),
      prisma.request.count({ where: { status: 'IMPORTED', createdAt: { gte: thirtyDaysAgo } } }),
      prisma.request.count({ where: { status: { in: ['FAILED', 'ERROR'] }, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.user.count()
    ]);

    let activeDownloads: any[] = [];
    let systemHealthy = true;

    try {
        activeDownloads = await DownloadService.getAllActiveDownloads();
    } catch (e) {
        systemHealthy = false;
    }

    // FIX: Retrieve version correctly 
    const currentVersion = process.env.npm_package_version || "1.0.0";
    let updateAvailable = false;
    let latestVersion = currentVersion;

    try {
        const res = await fetch('https://api.github.com/repos/hankscafe/omnibus/releases?per_page=1', {
            headers: { 'User-Agent': 'Omnibus-App', 'Accept': 'application/vnd.github.v3+json' },
            next: { revalidate: 3600 } 
        });
        if (res.ok) {
            const releases = await res.json();
            if (releases && releases.length > 0) {
                latestVersion = releases[0].tag_name.replace(/^v/, '');
                updateAvailable = isNewerVersion(latestVersion, currentVersion);
            }
        }
    } catch (e) {}

    let healthLabel = systemHealthy ? 'Healthy' : 'Degraded (Download Client Issue)';
    if (systemHealthy && updateAvailable) healthLabel = 'Update Available';

    console.log(`[Stats API] Successfully served stats to Homepage.`);

    return NextResponse.json({
      success: true,
      data: {
        systemHealth: healthLabel, updateAvailable, currentVersion, latestVersion,
        totalSeries, totalIssues, totalRequests, completed30d, failed30d, totalUsers,
        activeDownloads: activeDownloads.length, queue: activeDownloads 
      }
    });
  } catch (error: any) {
    console.error(`[Stats API] Server Error: ${error.message}`);
    return NextResponse.json({ error: 'Internal Server Error', details: error.message }, { status: 500 });
  }
}