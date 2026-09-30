// src/app/api/koreader/syncs/progress/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { recordDailyReading } from '@/lib/reading-stats';
import { authenticateKoreader, koreaderUnauthorizedResponse } from '@/lib/koreader-auth';
import { findIssueByKoreaderDocument } from '@/lib/koreader-documents';
import { koreaderPosition, pagesReadSince } from '@/lib/koreader-progress';

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

        // Which issue this is. First KOReader's document ID - the partial-MD5 checksum (its default) or
        // filename MD5 recorded when Omnibus served the file (koreader-documents.ts) - so a book
        // downloaded from Omnibus binds without any KOReader option. Otherwise the opt-in
        // metadata.filename, matched exactly and unambiguously so a duplicate basename cannot bind wrong.
        let matchedIssue = typeof document === 'string' && document ? await findIssueByKoreaderDocument(document) : null;
        const metadataFilename = typeof metadata?.filename === 'string' ? metadata.filename.trim() : '';
        if (!matchedIssue && metadataFilename) {
            const basename = metadataFilename.split(/[\\/]/).pop() || metadataFilename;
            const candidates = await prisma.issue.findMany({
                where: { filePath: { endsWith: basename } },
                select: { id: true, pageCount: true, filePath: true }
            });
            const exactCandidates = candidates.filter(issue =>
                issue.filePath && (issue.filePath.split(/[\\/]/).pop() === basename)
            );
            matchedIssue = exactCandidates.length === 1 ? exactCandidates[0] : null;
        }

        if (matchedIssue) {
            // #217: KOReader's page is 1-based, ReadProgress.currentPage is the web reader's 0-based index.
            const position = koreaderPosition(progress, percentage, matchedIssue.pageCount);

            // Feed the activity heatmap with the pages between the last position and this one.
            // Stats failures must never break the actual progress sync.
            try {
                const oldProgress = await prisma.readProgress.findUnique({
                    where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } }
                });
                await recordDailyReading(user.id, matchedIssue.id, pagesReadSince(oldProgress, position));
            } catch (statError) {
                Logger.log(`[KOReader Sync API] Failed to record heatmap stats: ${getErrorMessage(statError)}`, 'warn');
            }

            await prisma.readProgress.upsert({
                where: { userId_issueId: { userId: user.id, issueId: matchedIssue.id } },
                update: position,
                create: { userId: user.id, issueId: matchedIssue.id, ...position }
            });
        }

        return NextResponse.json({ document });
    } catch (error: unknown) {
        Logger.log(`[KOReader Sync API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ code: 2000, message: 'KOReader progress sync failed' }, { status: 500 });
    }
}
