// src/app/api/koreader/syncs/progress/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function PUT(request: Request) {
    try {
    // 1. Inline KOReader Auth
    const userHeader = request.headers.get('x-auth-user');
    const keyHeader = request.headers.get('x-auth-key');

    if (!userHeader || !keyHeader) return NextResponse.json({ authorized: "KO" }, { status: 401 });

    const keyHash = crypto.createHash('sha256').update(keyHeader).digest('hex');
    let user = null;

    const opdsKey = await prisma.opdsKey.findUnique({ where: { keyHash }, include: { user: true } });
    if (opdsKey && opdsKey.user.username === userHeader) user = opdsKey.user;

    if (!user) {
        const adminKey = await prisma.apiKey.findUnique({ where: { keyHash }, include: { user: true } });
        if (adminKey && adminKey.user.username === userHeader) user = adminKey.user;
    }

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
    const matchedIssue = await prisma.issue.findFirst({
        where: { filePath: { endsWith: document } }
    });

    if (matchedIssue) {
        const currentSimulatedPage = Math.round(percentage * 100);
        const isCompleted = percentage >= 0.99;

        await prisma.readProgress.upsert({
            where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } },
            update: { 
                currentPage: currentSimulatedPage,
                totalPages: 100,
                isCompleted: isCompleted 
            },
            create: { 
                userId: user.id, 
                issueId: matchedIssue.id, 
                currentPage: currentSimulatedPage,
                totalPages: 100,
                isCompleted: isCompleted 
            }
        });
    }

    return NextResponse.json({ document });
    } catch (error: unknown) {
        Logger.log(`[KOReader Sync API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ authorized: "KO" }, { status: 500 });
    }
}