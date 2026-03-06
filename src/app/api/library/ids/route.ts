export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    // Only return series/issues that actually have a physical file linked to them!
    // A valid file path will always contain a dot (e.g. .cbz, .cbr)
    const series = await prisma.series.findMany({ 
        where: { issues: { some: { filePath: { contains: '.' } } } },
        select: { cvId: true } 
    });
    
    const issues = await prisma.issue.findMany({ 
        where: { filePath: { contains: '.' } },
        select: { cvId: true } 
    });
    
    const requests = await prisma.request.findMany({ 
        select: { volumeId: true, status: true, activeDownloadName: true } 
    });

    return NextResponse.json({
        series: series.map(s => s.cvId),
        issues: issues.map(i => i.cvId),
        requests: requests.map(r => ({ 
            volumeId: parseInt(r.volumeId), 
            status: r.status, 
            name: r.activeDownloadName 
        }))
    });
  } catch (error) {
    return NextResponse.json({ series: [], issues: [], requests: [] });
  }
}