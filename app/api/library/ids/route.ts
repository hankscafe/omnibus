export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    // Fetch from all 3 tables to get a complete picture of ownership and pending requests
    const series = await prisma.series.findMany({ select: { cvId: true } });
    const issues = await prisma.issue.findMany({ select: { cvId: true } });
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