import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { runSystemHealthCheck } from '@/lib/health-checker';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const force = searchParams.get('force') === 'true';

        if (force) {
            const freshData = await runSystemHealthCheck();
            return NextResponse.json(freshData);
        }

        const cache = await prisma.systemSetting.findUnique({ where: { key: 'system_health_cache' } });
        if (cache?.value) {
            return NextResponse.json(JSON.parse(cache.value));
        }

        // Run if no cache exists yet
        const freshData = await runSystemHealthCheck();
        return NextResponse.json(freshData);

    } catch (error: unknown) {
        Logger.log(`Health Check API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}