export const dynamic = 'force-dynamic';

// Admin: move one or more issues to a different series. Fixes a mis-match where issues ended up under
// the wrong series (e.g. a bulk Custom-ID merge collapsed two folders into one). Each issue's file is
// relocated into the target series' folder and its seriesId is re-pointed. The target may be an existing
// series or a NEW (unmatched) series created from a name — which the admin can then match normally.
import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

// Move a file into destDir without ever overwriting; on a name clash append " (n)". Returns the final path.
async function moveFileNoClobber(srcPath: string, destDir: string): Promise<string> {
    await fs.ensureDir(destDir);
    const ext = path.extname(srcPath);
    const base = path.basename(srcPath, ext);
    let dest = path.join(destDir, `${base}${ext}`);
    let n = 1;
    while (await fs.pathExists(dest) && path.normalize(dest).toLowerCase() !== path.normalize(srcPath).toLowerCase()) {
        dest = path.join(destDir, `${base} (${n})${ext}`);
        n++;
    }
    if (path.normalize(dest).toLowerCase() !== path.normalize(srcPath).toLowerCase()) {
        await fs.move(srcPath, dest, { overwrite: false });
    }
    return dest;
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        const body = await request.json();
        const issueIds: string[] = Array.isArray(body?.issueIds) ? body.issueIds.filter((x: any) => typeof x === 'string') : [];
        const targetSeriesId: string | undefined = typeof body?.targetSeriesId === 'string' ? body.targetSeriesId : undefined;
        const newSeriesName: string | undefined = typeof body?.newSeriesName === 'string' ? body.newSeriesName.trim() : undefined;

        if (issueIds.length === 0) return NextResponse.json({ error: 'No issues selected.' }, { status: 400 });

        const issues = await prisma.issue.findMany({ where: { id: { in: issueIds } }, include: { series: true } });
        if (issues.length === 0) return NextResponse.json({ error: 'Issues not found.' }, { status: 404 });

        // Resolve the target series — an existing one, or a new UNMATCHED one created from a name.
        let target: { id: string; name: string; folderPath: string } | null = null;
        if (targetSeriesId) {
            const existing = await prisma.series.findUnique({ where: { id: targetSeriesId } });
            if (!existing) return NextResponse.json({ error: 'Target series not found.' }, { status: 404 });
            if (!existing.folderPath) return NextResponse.json({ error: 'Target series has no folder.' }, { status: 400 });
            target = { id: existing.id, name: existing.name, folderPath: existing.folderPath };
        } else if (newSeriesName) {
            const srcSeries = issues[0].series;
            const library = srcSeries?.libraryId
                ? await prisma.library.findUnique({ where: { id: srcSeries.libraryId } })
                : await prisma.library.findFirst();
            if (!library) return NextResponse.json({ error: 'No library available for the new series.' }, { status: 400 });
            const safeName = newSeriesName.replace(/[<>:"/\\|?*]/g, '').trim() || 'New Series';
            const folderPath = path.join(library.path, safeName).replace(/\\/g, '/');
            await fs.ensureDir(folderPath);
            const created = await prisma.series.create({
                data: {
                    name: newSeriesName,
                    folderPath,
                    libraryId: library.id,
                    isManga: srcSeries?.isManga ?? library.isManga ?? false,
                    year: 0,
                    matchState: 'UNMATCHED',
                }
            });
            target = { id: created.id, name: created.name, folderPath: created.folderPath };
        } else {
            return NextResponse.json({ error: 'Provide a target series or a new series name.' }, { status: 400 });
        }

        await fs.ensureDir(target.folderPath);

        let moved = 0;
        const conflicts: string[] = [];
        for (const issue of issues) {
            if (issue.seriesId === target.id) continue; // already in the target

            let newFilePath = issue.filePath;
            if (issue.filePath && await fs.pathExists(issue.filePath)) {
                try {
                    newFilePath = await moveFileNoClobber(issue.filePath, target.folderPath);
                } catch (e) {
                    Logger.log(`[Issue Move] Failed to relocate file for issue ${issue.id}: ${getErrorMessage(e)}`, 'warn');
                    conflicts.push(issue.id);
                    continue; // leave the issue where it is rather than de-syncing the DB from disk
                }
            }
            await prisma.issue.update({ where: { id: issue.id }, data: { seriesId: target.id, filePath: newFilePath } });
            moved++;
        }

        await AuditLogger.log('MOVE_ISSUES', {
            count: moved,
            targetSeriesId: target.id,
            targetSeriesName: target.name,
            createdNewSeries: !targetSeriesId,
        }, (session.user as any).id);

        return NextResponse.json({ success: true, moved, conflicts: conflicts.length, targetSeriesId: target.id, targetName: target.name });
    } catch (error: unknown) {
        Logger.log(`[Issue Move] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
