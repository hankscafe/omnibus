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
    if (globalForCache.libraryIdsCache && globalForCache.libraryIdsCacheTime && now - globalForCache.libraryIdsCacheTime < 30000) {
        return NextResponse.json(globalForCache.libraryIdsCache);
    }

    // --- SCHEMA FIX: Use metadataId to check presence in DB ---
    const [series, issues, requests] = await Promise.all([
        prisma.series.findMany({ 
            where: { issues: { some: { filePath: { not: null } } }, metadataId: { not: null } },
            select: { metadataId: true, monitored: true }
        }),
        prisma.issue.findMany({ 
            where: { filePath: { not: null }, metadataId: { not: null } },
            select: { metadataId: true } 
        }),
        prisma.request.findMany({ 
            select: { volumeId: true, status: true, activeDownloadName: true } 
        })
    ]);

    const payload = {
        series: series.map(s => parseInt(s.metadataId!)).filter(id => !isNaN(id)),
        monitored: series.filter(s => s.monitored).map(s => parseInt(s.metadataId!)).filter(id => !isNaN(id)),
        issues: issues.map(i => parseInt(i.metadataId!)).filter(id => !isNaN(id)),
        requests: requests.map(r => ({ 
            volumeId: parseInt(r.volumeId), 
            status: r.status, 
            name: r.activeDownloadName 
        }))
    };

    globalForCache.libraryIdsCache = payload;
    globalForCache.libraryIdsCacheTime = now;

    return NextResponse.json(payload);
  } catch (error) {
    Logger.log(`Library IDs API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ series: [], monitored: [], issues: [], requests: [] }); 
  }
}