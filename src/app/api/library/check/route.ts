export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cvIdParam = searchParams.get('cvId');

  if (!cvIdParam) return NextResponse.json({ owned: false });

  const cvId = parseInt(cvIdParam, 10);
  if (isNaN(cvId)) return NextResponse.json({ owned: false });

  try {
    // Check if the ComicVine ID exists as a Series (Volume) or an individual Issue
    const [seriesMatch, issueMatch] = await Promise.all([
      prisma.series.findUnique({ where: { cvId } }),
      prisma.issue.findUnique({ where: { cvId } })
    ]);

    return NextResponse.json({ owned: !!(seriesMatch || issueMatch) });
  } catch (error) {
    console.error("Library check error:", error);
    return NextResponse.json({ owned: false });
  }
}