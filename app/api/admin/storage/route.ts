import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

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
            series: JSON.parse(cache.value),
            lastRun: lastRun?.value || null
        });
    }

    // If cache is entirely missing (first run), flag it so the UI can trigger a scan
    return NextResponse.json({ series: [], lastRun: null, needsScan: true });

  } catch (error: any) {
    console.error("Storage Cache Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}