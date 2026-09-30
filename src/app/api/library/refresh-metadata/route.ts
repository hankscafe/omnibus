import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { metronCreditCandidatesWhere, metronDetailCreditsEnabled } from '@/lib/metron/credit-candidates';

async function isAdmin() {
  const session = await getServerSession(await getAuthOptions());
  return (session?.user as { role?: string } | undefined)?.role === 'ADMIN';
}

/**
 * What a series' Refresh Metadata button asks before refreshing (Metron beta 4): with the "per-issue
 * credits" setting off, a refresh doesn't fetch per-issue Metron credits, so the button offers them
 * when issues on disk are missing them - `missingCredits` is how many (one Metron request each).
 */
export async function GET(request: Request) {
  try {
    if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const { searchParams } = new URL(request.url);
    const metadataId = searchParams.get('metadataId');
    const metadataSource = searchParams.get('metadataSource') || 'COMICVINE';
    if (!metadataId) return NextResponse.json({ error: "Missing metadata ID" }, { status: 400 });

    const series = await prisma.series.findFirst({ where: { metadataId, metadataSource } });
    if (!series) return NextResponse.json({ error: "Series not found in database." }, { status: 404 });

    const creditsEnabled = await metronDetailCreditsEnabled();
    const missingCredits = series.metadataSource === 'METRON'
      ? await prisma.issue.count({ where: metronCreditCandidatesWhere(series.id) })
      : 0;
    return NextResponse.json({ creditsEnabled, missingCredits });
  } catch (error: unknown) {
    Logger.log(`Refresh Metadata preflight failed: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // Queues a provider metadata re-sync that overwrites series/issue records — admin-only.
    if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const { cvId, metadataId, metadataSource, fetchCredits } = await request.json();

    const targetId = metadataId || (cvId ? cvId.toString() : null);
    const targetSource = metadataSource || 'COMICVINE';

    if (!targetId) return NextResponse.json({ error: "Missing metadata ID" }, { status: 400 });

    const series = await prisma.series.findFirst({
        where: { metadataId: targetId, metadataSource: targetSource }
    });

    if (!series) {
        return NextResponse.json({ error: "Series not found in database." }, { status: 404 });
    }

    // Safely hand the long-running task to BullMQ. fetchCredits: a yes to the button's per-issue
    // credits ask - only ever an explicit true; every other refresh follows the setting.
    await omnibusQueue.add('METADATA_SYNC', {
        type: 'METADATA_SYNC',
        seriesIds: [series.id],
        ...(fetchCredits === true ? { fetchCredits: true } : {})
    }, {
        jobId: `METADATA_SYNC_MANUAL_${series.id}_${Date.now()}`
    });

    Logger.log(`[Metadata] Manual refresh for "${series.name}" queued in background${fetchCredits === true ? ' (with per-issue Metron credits)' : ''}.`, 'info');

    return NextResponse.json({ success: true, message: "Metadata sync queued." });
  } catch (error: unknown) {
    Logger.log(`Refresh Metadata Failed: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
