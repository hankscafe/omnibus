// src/app/api/library/ids/route.ts

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getAccessibleLibraryIds, seriesAccessWhere, nestedSeriesAccessWhere } from '@/lib/library-access';
import { ownedCoverageBySeries } from '@/lib/coverage-ownership';
import { isCovered } from '@/lib/utils/coverage';

const globalForCache = globalThis as unknown as {
    libraryIdsCache: any;
    libraryIdsCacheTime: number;
};

export async function GET() {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const accessibleLibs = await getAccessibleLibraryIds(session?.user?.id, session?.user?.role);
    const isAll = accessibleLibs === 'ALL';

    const now = Date.now();
    // Per-library access: only admins (who see everything) share the 30s cache; scoped users compute fresh.
    if (isAll && globalForCache.libraryIdsCache && globalForCache.libraryIdsCacheTime && now - globalForCache.libraryIdsCacheTime < 30000) {
        return NextResponse.json(globalForCache.libraryIdsCache);
    }

    const [series, issues, requests] = await Promise.all([
        prisma.series.findMany({
            where: { issues: { some: { filePath: { not: null } } }, metadataId: { not: null }, ...seriesAccessWhere(accessibleLibs) },
            select: { cvId: true, metadataId: true, monitored: true, name: true }
        }),
        prisma.issue.findMany({
            where: { filePath: { not: null }, metadataId: { not: null }, ...nestedSeriesAccessWhere(accessibleLibs) },
            select: { cvId: true, metadataId: true, number: true, series: { select: { name: true } } }
        }),
        prisma.request.findMany({ 
            select: { volumeId: true, status: true, activeDownloadName: true } 
        })
    ]);

    // #203 COLLECTED coverage: a run issue nobody has on disk but an OWNED collected edition
    // reprints is not missing. Its provider id rides in a list of its own — Discover and the
    // request search badge it as covered, and a volume's "Request Missing" leaves it alone — never
    // among the owned ids (it is not "In Library"). Two extra lookups, only when something covers.
    const coverage = await ownedCoverageBySeries(nestedSeriesAccessWhere(accessibleLibs));
    let covered: string[] = [];
    if (coverage.size > 0) {
        const candidates = await prisma.issue.findMany({
            where: {
                seriesId: { in: Array.from(coverage.keys()) },
                filePath: null, attachedVolumeId: null, isAnnual: false, metadataId: { not: null },
                ...nestedSeriesAccessWhere(accessibleLibs),
            },
            select: { seriesId: true, number: true, cvId: true, metadataId: true },
        });
        covered = candidates
            .filter(i => isCovered(i.number, coverage.get(i.seriesId) || []))
            .map(i => String(i.cvId || i.metadataId))
            .filter(Boolean);
    }

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
        covered,

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

    if (isAll) {
        globalForCache.libraryIdsCache = payload;
        globalForCache.libraryIdsCacheTime = now;
    }

    return NextResponse.json(payload);
  } catch (error) {
    Logger.log(`Library IDs API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ 
        series: [], monitored: [], issues: [], covered: [],
        seriesNames: [], monitoredNames: [], issueNames: [],
        requests: [] 
    }); 
  }
}