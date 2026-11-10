import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import type { StorageReply, StorageSeriesEntry } from '@/types/api/admin';

export async function GET() {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    
    if (session?.user?.role !== 'ADMIN') {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const cache = await prisma.systemSetting.findUnique({ where: { key: 'storage_deep_dive_cache' } });
    const lastRun = await prisma.systemSetting.findUnique({ where: { key: 'storage_deep_dive_last_run' } });

    if (cache?.value) {
        return NextResponse.json({
            // The engine's storage deep-dive writes the cache (diagnostics.rs StorageEntry).
            series: JSON.parse(cache.value) as StorageSeriesEntry[],
            lastRun: lastRun?.value || null
        } satisfies StorageReply);
    }

    // If cache is entirely missing (first run), flag it so the UI can trigger a scan
    return NextResponse.json({ series: [], lastRun: null, needsScan: true } satisfies StorageReply);

  } catch (error: unknown) {
    Logger.log(`Storage Cache Errorw: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}