// src/app/api/library/repack/route.ts
import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { seriesIds } = await request.json();
        
        if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
            return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
        }

        // Add to the native BullMQ queue
        await omnibusQueue.add('REPACK_ARCHIVES', { type: 'REPACK_ARCHIVES', seriesIds }, {
            jobId: `REPACK_${Date.now()}`
        });

        return NextResponse.json({ success: true, message: "Repacking job queued." });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}