// src/app/api/koreader/syncs/progress/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { authenticateKoreader } from '../../users/auth/route';

export async function PUT(request: Request) {
    const user = await authenticateKoreader(request);
    if (!user) return NextResponse.json({ authorized: "KO" }, { status: 401 });

    const body = await request.json();
    const { document, progress, percentage, device, device_id } = body;
    const timestamp = Math.floor(Date.now() / 1000);

    // Save KOReader's exact page state
    await prisma.koreaderSync.upsert({
        where: {
            userId_document: { userId: user.id, document: document }
        },
        update: { progress, percentage, device, deviceId: device_id, timestamp },
        create: { userId: user.id, document, progress, percentage, device, deviceId: device_id, timestamp }
    });

    // Optional: Sync this progress back to the Omnibus Web UI!
    // Since KOReader's "document" might be the filename, we can try to find the matching Omnibus issue
    const matchedIssue = await prisma.issue.findFirst({
        where: { filePath: { endsWith: document } }
    });

    if (matchedIssue) {
        await prisma.readingProgress.upsert({
            where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } },
            update: { percentage: percentage * 100, isCompleted: percentage >= 0.99 },
            create: { userId: user.id, issueId: matchedIssue.id, percentage: percentage * 100, isCompleted: percentage >= 0.99 }
        });
    }

    return NextResponse.json({ document });
}