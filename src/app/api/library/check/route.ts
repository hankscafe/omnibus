export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cvIdParam = searchParams.get('cvId');

  if (!cvIdParam) return NextResponse.json({ owned: false });

  try {
    const [seriesMatch, issueMatch] = await Promise.all([
      prisma.series.findUnique({ 
          where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: cvIdParam } } 
      }),
      prisma.issue.findFirst({ 
          where: { metadataId: cvIdParam, metadataSource: 'COMICVINE' } 
      })
    ]);

    return NextResponse.json({ owned: !!(seriesMatch || issueMatch) });
  } catch (error) {
    Logger.log(`Library check error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ owned: false });
  }
}