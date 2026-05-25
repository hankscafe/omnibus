// src/app/api/library/ids/route.ts

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const globalForCache = globalThis as unknown as {
    libraryIdsCache: any;
    libraryIdsCacheTime: number;
};

export async function GET() {
  try {
    const now = Date.now();
    // Keep the existing 30-second memory cache
    if (globalForCache.libraryIdsCache && globalForCache.libraryIdsCacheTime && now - globalForCache.libraryIdsCacheTime < 30000) {
        return NextResponse.json(globalForCache.libraryIdsCache);
    }

    const [series, issues, requests] = await Promise.all([
        prisma.series.findMany({ 
            where: { issues: { some: { filePath: { not: null } } }, metadataId: { not: null } },
            select: { cvId: true, metadataId: true, monitored: true, name: true }
        }),
        prisma.issue.findMany({ 
            where: { filePath: { not: null }, metadataId: { not: null } },
            select: { cvId: true, metadataId: true, number: true, series: { select: { name: true } } } 
        }),
        prisma.request.findMany({ 
            select: { volumeId: true, status: true, activeDownloadName: true } 
        })
    ]);

    // Construct the fallback arrays
    const seriesNamesFallback = series.map(s => s.name).filter(Boolean);
    const issueNamesFallback = issues.map(i => {
        if (!i.series?.name || !i.number) return null;
        const parsedNum = parseFloat(i.number);
        return `${i.series.name} #${isNaN(parsedNum) ? i.number : parsedNum}`;
    }).filter(Boolean);

    Logger.log(`[Library ID Debug] Broadcasting ID payload. Standard Series IDs: ${series.length}, Name Fallbacks: ${seriesNamesFallback.length}, Issue Fallbacks: ${issueNamesFallback.length}`, 'debug');

    const payload = {
        // Standard ID matches (Preserves legacy cvId checks)
        series: series.map(s => s.cvId || s.metadataId).filter(Boolean),
        monitored: series.filter(s => s.monitored).map(s => s.cvId || s.metadataId).filter(Boolean),
        issues: issues.map(i => i.cvId || i.metadataId).filter(Boolean),
        
        // --- Cross-Provider Name Fallbacks with Number Normalization ---
        seriesNames: seriesNamesFallback,
        monitoredNames: series.filter(s => s.monitored).map(s => s.name).filter(Boolean),
        issueNames: issueNamesFallback,

        requests: requests.map(r => ({ 
            volumeId: r.volumeId, 
            status: r.status, 
            name: r.activeDownloadName 
        }))
    };

    globalForCache.libraryIdsCache = payload;
    globalForCache.libraryIdsCacheTime = now;

    return NextResponse.json(payload);
  } catch (error) {
    Logger.log(`Library IDs API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ 
        series: [], monitored: [], issues: [], 
        seriesNames: [], monitoredNames: [], issueNames: [], 
        requests: [] 
    }); 
  }
}