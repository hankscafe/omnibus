// src/app/api/koreader/syncs/progress/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { recordDailyReading } from '@/lib/reading-stats';

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

    // Optional: Sync this progress back to the Omnibus Web UI! KOReader reports a bare basename, and an
    // unanchored endsWith can bind the WRONG issue (duplicate basenames across series, or a suffix like
    // '1.cbz' matching '001.cbz'). Filter to an EXACT filename match and only bind when it's unambiguous.
    const docStr = String(document);
    const docBase = docStr.split(/[\\/]/).pop() || docStr;
    const koNorm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    // Candidates by EXACT filename (so '1.cbz' can't suffix-match '001.cbz'), robust to differing path roots.
    const koCandidates = (await prisma.issue.findMany({ where: { filePath: { endsWith: docBase } } }))
        .filter(i => i.filePath && i.filePath.split(/[\\/]/).pop() === docBase);
    // If KOReader reported a full path and several files share the basename, disambiguate by the path suffix.
    const koByPath = (docStr.includes('/') || docStr.includes('\\'))
        ? koCandidates.filter(i => koNorm(i.filePath!).endsWith(koNorm(docStr)))
        : [];
    const matchedIssue = koByPath.length === 1 ? koByPath[0] : (koCandidates.length === 1 ? koCandidates[0] : null);

    if (matchedIssue) {
        const newPercentage = Math.max(0, Math.min(1, Number(percentage) || 0));
        const currentSimulatedPage = Math.round(newPercentage * 100);
        const isCompleted = newPercentage >= 0.99;

        // Feed the activity heatmap: convert the percentage advance into pages.
        // Stats failures must never break the actual progress sync.
        try {
            const oldProgress = await prisma.readProgress.findUnique({
                where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } }
            });
            const oldPercentage = oldProgress && oldProgress.totalPages > 0
                ? Math.min(1, oldProgress.currentPage / oldProgress.totalPages)
                : 0;
            // Use the issue's real page count when known; otherwise percentage points stand in for pages
            const pageBasis = matchedIssue.pageCount > 0 ? matchedIssue.pageCount : 100;
            const pagesReadDelta = Math.round(Math.max(0, newPercentage - oldPercentage) * pageBasis);
            await recordDailyReading(user.id, matchedIssue.id, pagesReadDelta);
        } catch (statError) {
            Logger.log(`[KOReader Sync API] Failed to record heatmap stats: ${getErrorMessage(statError)}`, 'warn');
        }

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