// src/app/api/library/issue/link/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { moveFileSafe } from '@/lib/utils/safe-fs';
import { countArchivePages } from '@/lib/utils/archive-pages';
import { carriedStamp } from '@/lib/file-added';
import { issueFileName, issuePaddingFromSetting, issueTitleForName } from '@/lib/utils/naming';
import { filePatternForIssue, namingAttachment, seriesTokenForIssue } from '@/lib/utils/file-pattern';

export async function POST(request: NextRequest) {
    try {
        const token = await getToken({ req: request });
        if (token?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const { unmatchedId, targetId } = await request.json();

        if (!unmatchedId || !targetId) {
            return NextResponse.json({ error: "Missing required IDs." }, { status: 400 });
        }

        Logger.log(`[Issue Link Debug] Incoming link request. Unmatched ID: [${unmatchedId}], Target ID: [${targetId}]`, 'debug');

        // 1. Fetch both the unmatched physical file record and the target metadata record
        const unmatchedIssue = await prisma.issue.findUnique({
            where: { id: unmatchedId },
            include: { series: true }
        });

        const targetIssue = await prisma.issue.findUnique({
            where: { id: targetId },
            include: { attachedVolume: { select: { kind: true, metadataSource: true, name: true, seriesId: true } } },
        });

        if (!unmatchedIssue || !targetIssue) {
            Logger.log(`[Issue Link Debug] Failed to find records in DB. Unmatched exists: ${!!unmatchedIssue}, Target exists: ${!!targetIssue}`, 'debug');
            return NextResponse.json({ error: "One or both issues could not be found." }, { status: 404 });
        }

        if (!unmatchedIssue.filePath) {
            Logger.log(`[Issue Link Debug] Unmatched issue [${unmatchedId}] has no physical filePath. Aborting.`, 'debug');
            return NextResponse.json({ error: "The selected unmatched issue does not have a physical file path." }, { status: 400 });
        }

        const series = unmatchedIssue.series;
        const oldFilePath = unmatchedIssue.filePath;
        const activeFolderPath = path.dirname(oldFilePath);
        const ext = path.extname(oldFilePath);

        // --- NEW: Human-readable context log ---
        const targetTitle = targetIssue.name || "Untitled Issue";
        Logger.log(`[Issue Link Debug] Linking file "${path.basename(oldFilePath)}" to official record: "${series.name}" Issue #${targetIssue.number} (${targetTitle})`, 'debug');

        // 2. Fetch System Settings for Naming Patterns
        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        // 3. Name the file with the shared naming rules (src/lib/utils/naming.ts) - the name Standardize
        //    would give it, through the same pattern choice (#203: an ANNUAL takes the Mylar shape; a
        //    collected book its collected pattern; #255: a Special its own, after its own volume).
        const attachment = namingAttachment(targetIssue);
        const isCollected = attachment?.kind === 'COLLECTED';
        const isSpecial = attachment?.kind === 'SPECIAL';
        const filePatternToUse = filePatternForIssue({
            isAnnual: targetIssue.isAnnual,
            isCollected,
            isSpecial,
            isManga: series.isManga,
            filePattern: config.file_naming_pattern || "{Series} #{Issue}",
            mangaFilePattern: config.manga_file_naming_pattern || "{Series} Vol. {Issue}",
            collectedFilePattern: config.collected_file_naming_pattern,
        });
        const stem = issueFileName(filePatternToUse, {
            publisher: series.publisher,
            series: seriesTokenForIssue({ isCollected, isSpecial, attachmentSource: attachment?.metadataSource, attachmentName: attachment?.name, seriesName: series.name }),
            seriesYear: series.year,
            issueNumber: targetIssue.number,
            releaseDate: targetIssue.releaseDate,
            issueTitle: issueTitleForName(targetIssue.name, series.name, targetIssue.number),
            universe: (series as any).universe,
            seriesGroup: (series as any).seriesGroup,
            imprint: series.imprint,
        }, issuePaddingFromSetting(config.issue_number_padding));
        const newFileName = (stem ?? path.basename(oldFilePath, ext)) + ext;

        const newFilePath = path.join(activeFolderPath, newFileName);
        let finalFilePath = newFilePath;

        Logger.log(`[Issue Link Debug] Generated new standardized path: ${finalFilePath}`, 'debug');

        // 5. Physically rename the file
        try {
            if (oldFilePath !== newFilePath) {
                if (fs.existsSync(newFilePath)) {
                    const baseName = path.basename(newFileName, ext);
                    finalFilePath = path.join(activeFolderPath, `${baseName} (Linked)${ext}`);
                    Logger.log(`[Issue Link Debug] Target file already exists! Appended '(Linked)' to prevent overwrite: ${finalFilePath}`, 'debug');
                }
                Logger.log(`[Issue Link Debug] Executing OS rename: [${oldFilePath}] -> [${finalFilePath}]`, 'debug');
                // Cross-device-safe: the unmatched source and the series folder are separate mounts in
                // most Docker setups, where a raw rename dies with EXDEV (discussion #169).
                await moveFileSafe(oldFilePath, finalFilePath);
            } else {
                Logger.log(`[Issue Link Debug] Old file path perfectly matches new file path. Skipping physical OS rename.`, 'debug');
            }
        } catch (err: any) {
            Logger.log(`[Issue Link Debug] OS RENAME FAILED: ${err.message}`, 'error');
            finalFilePath = oldFilePath;
        }

        // 6. Update the target issue with the new file path and delete the unmatched record
        await prisma.$transaction([
            prisma.issue.update({
                where: { id: targetId },
                data: {
                    filePath: finalFilePath,
                    status: 'DOWNLOADED',
                    // Persist the page total so OPDS (pse:count) can stream this issue.
                    pageCount: await countArchivePages(finalFilePath),
                    // #206 follow-up: a re-home, not an arrival — the file keeps the time the
                    // unmatched row it came from was announced with.
                    fileAddedAt: carriedStamp(unmatchedIssue),
                }
            }),
            prisma.issue.delete({
                where: { id: unmatchedId }
            })
        ]);

        Logger.log(`[Issue Link Debug] Database transaction complete. Unmatched dummy record deleted, Official record [${targetId}] attached to file.`, 'debug');

        await AuditLogger.log('LINK_ISSUE', { 
            unmatchedId, 
            targetId, 
            oldPath: oldFilePath, 
            newPath: finalFilePath 
        }, (token.id || token.sub) as string);

        return NextResponse.json({ success: true, newFilePath: finalFilePath });

    } catch (error: unknown) {
        Logger.log(`[Library Issue Link API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
