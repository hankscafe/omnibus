// src/app/api/library/issue/link/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: NextRequest) {
    try {
        // Use getToken instead of getServerSession for reliable App Router auth
        const token = await getToken({ req: request });
        if (token?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const { unmatchedId, targetId } = await request.json();

        if (!unmatchedId || !targetId) {
            return NextResponse.json({ error: "Missing required IDs." }, { status: 400 });
        }

        // 1. Fetch both the unmatched physical file record and the target metadata record
        const unmatchedIssue = await prisma.issue.findUnique({
            where: { id: unmatchedId },
            include: { series: true }
        });

        const targetIssue = await prisma.issue.findUnique({
            where: { id: targetId }
        });

        if (!unmatchedIssue || !targetIssue) {
            return NextResponse.json({ error: "One or both issues could not be found." }, { status: 404 });
        }

        if (!unmatchedIssue.filePath) {
            return NextResponse.json({ error: "The selected unmatched issue does not have a physical file path." }, { status: 400 });
        }

        const series = unmatchedIssue.series;
        const oldFilePath = unmatchedIssue.filePath;
        const activeFolderPath = path.dirname(oldFilePath);
        const ext = path.extname(oldFilePath);

        // 2. Fetch System Settings for Naming Patterns
        const settings = await prisma.systemSetting.findMany();
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        // 3. Prepare the naming variables
        const safePublisher = series.publisher ? series.publisher.replace(/[<>:"/\\|?*]/g, '').trim() : "Other";
        const safeName = series.name ? series.name.replace(/[<>:"/\\|?*]/g, '').trim() : "Unknown Series";
        const safeYear = series.year ? series.year.toString() : "";
        
        let issueNumStr = targetIssue.number;
        let formattedNum = issueNumStr;
        // Pad single digit issue numbers with a leading zero
        if (issueNumStr && !issueNumStr.includes('.') && issueNumStr.length === 1) {
            formattedNum = `0${issueNumStr}`;
        }

        const filePatternToUse = series.isManga 
            ? (config.manga_file_naming_pattern || "{Series} Vol. {Issue}")
            : (config.file_naming_pattern || "{Series} #{Issue}");

        // 4. Generate the new file name
        const newFileName = filePatternToUse
            .replace(/{Publisher}/gi, safePublisher)
            .replace(/{Series}/gi, safeName)
            .replace(/{Year}/gi, safeYear)
            .replace(/{Issue}/gi, formattedNum || "")
            .replace(/\(\s*\)/g, '')
            .replace(/\[\s*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim() + ext;

        const newFilePath = path.join(activeFolderPath, newFileName);
        let finalFilePath = newFilePath;

        // 5. Physically rename the file (safeguard against overwriting existing files)
        try {
            if (oldFilePath !== newFilePath) {
                if (fs.existsSync(newFilePath)) {
                    const baseName = path.basename(newFileName, ext);
                    finalFilePath = path.join(activeFolderPath, `${baseName} (Linked)${ext}`);
                }
                await fs.promises.rename(oldFilePath, finalFilePath);
            }
        } catch (err: any) {
            Logger.log(`[Issue Link] Failed to rename file: ${err.message}`, 'error');
            // If the rename fails (e.g., permissions), fallback to keeping the old path so the DB link still works
            finalFilePath = oldFilePath;
        }

        // 6. Update the target issue with the new file path and delete the unmatched record
        await prisma.$transaction([
            prisma.issue.update({
                where: { id: targetId },
                data: {
                    filePath: finalFilePath,
                    status: 'DOWNLOADED'
                }
            }),
            prisma.issue.delete({
                where: { id: unmatchedId }
            })
        ]);

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