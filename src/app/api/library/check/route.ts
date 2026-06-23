export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getAccessibleLibraryIds, seriesAccessWhere, nestedSeriesAccessWhere } from '@/lib/library-access';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cvIdParam = searchParams.get('cvId');
  const provider = searchParams.get('provider') || 'COMICVINE'; // <-- ADD THIS

  if (!cvIdParam) return NextResponse.json({ owned: false });

  try {
    // Per-library access: a match only counts as "owned" if it lives in a library the user can access.
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const accessibleLibs = await getAccessibleLibraryIds((session?.user as any)?.id, (session?.user as any)?.role);

    const [seriesMatch, issueMatch] = await Promise.all([
      prisma.series.findFirst({
          where: { metadataSource: provider, metadataId: cvIdParam, ...seriesAccessWhere(accessibleLibs) }
      }),
      prisma.issue.findFirst({
          where: { metadataId: cvIdParam, metadataSource: provider, ...nestedSeriesAccessWhere(accessibleLibs) }
      })
    ]);

    return NextResponse.json({ owned: !!(seriesMatch || issueMatch) });
  } catch (error) {
    Logger.log(`Library check error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ owned: false });
  }
}