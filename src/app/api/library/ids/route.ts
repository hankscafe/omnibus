export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// In-memory cache to prevent DB spam and massive memory spikes
const globalForCache = globalThis as unknown as {
    libraryIdsCache: any;
    libraryIdsCacheTime: number;
};

export async function GET() {
  try {
    const now = Date.now();
    // Serve from cache if requested within the last 30 seconds
    if (globalForCache.libraryIdsCache && globalForCache.libraryIdsCacheTime && now - globalForCache.libraryIdsCacheTime < 30000) {
        return NextResponse.json(globalForCache.libraryIdsCache);
    }

    // Only return series/issues that actually have a physical file linked to them!
    // OPTIMIZATION: Removed `{ contains: '.' }` as it causes full table scans.
    const [series, issues, requests] = await Promise.all([
        prisma.series.findMany({ 
            where: { issues: { some: { filePath: { not: null, not: '' } } } },
            select: { cvId: true } 
        }),
        prisma.issue.findMany({ 
            where: { filePath: { not: null, not: '' } },
            select: { cvId: true } 
        }),
        prisma.request.findMany({ 
            select: { volumeId: true, status: true, activeDownloadName: true } 
        })
    ]);

    const payload = {
        series: series.map(s => s.cvId),
        issues: issues.map(i => i.cvId),
        requests: requests.map(r => ({ 
            volumeId: parseInt(r.volumeId), 
            status: r.status, 
            name: r.activeDownloadName 
        }))
    };

    // Save to cache
    globalForCache.libraryIdsCache = payload;
    globalForCache.libraryIdsCacheTime = now;

    return NextResponse.json(payload);
  } catch (error) {
    Logger.log("Library IDs API Error:", error, 'error');
    return NextResponse.json({ series: [], issues: [], requests: [] });
  }
}