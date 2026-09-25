// src/app/api/koreader/syncs/progress/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { recordDailyReading } from '@/lib/reading-stats';
import { authenticateKoreader, koreaderUnauthorizedResponse } from '@/lib/koreader-auth';

export async function PUT(request: Request) {
    try {
        const auth = await authenticateKoreader(request);
        if (!auth.user) return koreaderUnauthorizedResponse(auth.error);
        const { user } = auth;

        const body = await request.json();
        const { document, metadata, progress, percentage, device, device_id } = body;
        const timestamp = Math.floor(Date.now() / 1000);

        // Save KOReader's exact device-to-device state even when Omnibus cannot bind it to a library issue.
        await prisma.koreaderSync.upsert({
            where: {
                userId_document: { userId: user.id, document: document }
            },
            update: { progress, percentage, device, deviceId: device_id, timestamp },
            create: { userId: user.id, document, progress, percentage, device, deviceId: device_id, timestamp }
        });

        // The document field is a digest, never a path. Only opt-in metadata.filename gives Omnibus a
        // real filename; matching remains exact and unambiguous so a duplicate basename cannot bind wrong.
        const metadataFilename = typeof metadata?.filename === 'string' ? metadata.filename.trim() : '';
        if (metadataFilename) {
            const basename = metadataFilename.split(/[\\/]/).pop() || metadataFilename;
            const candidates = await prisma.issue.findMany({
                where: { filePath: { endsWith: basename } },
                select: { id: true, pageCount: true, filePath: true }
            });
            const exactCandidates = candidates.filter(issue =>
                issue.filePath && (issue.filePath.split(/[\\/]/).pop() === basename)
            );
            const matchedIssue = exactCandidates.length === 1 ? exactCandidates[0] : null;

            if (matchedIssue) {
                const newPercentage = Math.max(0, Math.min(1, Number(percentage) || 0));
                const totalPages = matchedIssue.pageCount > 0 ? matchedIssue.pageCount : 100;
                const currentPage = Math.round(newPercentage * totalPages);
                const isCompleted = newPercentage >= 0.99;

                // Feed the activity heatmap: convert the percentage advance into real pages.
                // Stats failures must never break the actual progress sync.
                try {
                    const oldProgress = await prisma.readProgress.findUnique({
                        where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } }
                    });
                    const oldPercentage = oldProgress && oldProgress.totalPages > 0
                        ? Math.min(1, oldProgress.currentPage / oldProgress.totalPages)
                        : 0;
                    const pagesReadDelta = Math.round(Math.max(0, newPercentage - oldPercentage) * totalPages);
                    await recordDailyReading(user.id, matchedIssue.id, pagesReadDelta);
                } catch (statError) {
                    Logger.log(`[KOReader Sync API] Failed to record heatmap stats: ${getErrorMessage(statError)}`, 'warn');
                }

                await prisma.readProgress.upsert({
                    where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } },
                    update: { currentPage, totalPages, isCompleted },
                    create: { userId: user.id, issueId: matchedIssue.id, currentPage, totalPages, isCompleted }
                });
            }
        }

        return NextResponse.json({ document });
    } catch (error: unknown) {
        Logger.log(`[KOReader Sync API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ code: 2000, message: 'KOReader progress sync failed' }, { status: 500 });
    }
}
