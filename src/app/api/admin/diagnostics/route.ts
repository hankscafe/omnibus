import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger'; // Import the logger
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { action, payload } = await request.json();
        const startTime = Date.now();

        // HELPER: Deep scan physical directories
        async function getPhysicalFiles(dir: string, fileList: string[] = []) {
            if (!fs.existsSync(dir)) return fileList;
            const items = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    await getPhysicalFiles(fullPath, fileList);
                } else if (item.name.match(/\.(cbz|cbr|zip)$/i)) {
                    fileList.push(fullPath);
                }
            }
            return fileList;
        }

        // --- SCAN: GHOST RECORDS ---
        if (action === 'scan-ghosts') {
            Logger.log("[UI Job] Manual Ghost Record scan started", "info");
            const series = await prisma.series.findMany();
            const issues = await prisma.issue.findMany({ include: { series: true } });

            const ghostSeries = series
                .filter(s => !s.folderPath || !fs.existsSync(s.folderPath))
                .map(s => ({ id: s.id, type: 'SERIES', name: s.name, path: s.folderPath || 'Missing Path' }));
            
            // FIX: Only flag issues as ghosts if they actually have a file path assigned but the file is missing from disk.
            // This safely ignores un-downloaded metadata stubs.
            const ghostIssues = issues
                .filter(i => i.filePath && i.filePath.trim().length > 0 && !fs.existsSync(i.filePath))
                .map(i => ({ id: i.id, type: 'ISSUE', name: `${i.series?.name} #${i.number}`, path: i.filePath }));

            const totalGhosts = ghostSeries.length + ghostIssues.length;

            // LOG TO DATABASE
            await prisma.jobLog.create({
                data: {
                    jobType: 'DIAGNOSTICS',
                    status: totalGhosts > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                    durationMs: Date.now() - startTime,
                    message: `Manual Ghost Scan found ${totalGhosts} broken links (${ghostSeries.length} series, ${ghostIssues.length} issues).`
                }
            });

            Logger.log(`Manual Ghost Scan complete. Found ${totalGhosts} issues.`, totalGhosts > 0 ? "warn" : "success");
            return NextResponse.json({ ghosts: [...ghostSeries, ...ghostIssues] });
        }

        // --- SCAN: ORPHANED FILES ---
        if (action === 'scan-orphans') {
            Logger.log("[UI Job] Manual Orphaned File scan started", "info");
            
            const libraries = await prisma.library.findMany();
            
            let physicalFiles: string[] = [];
            for (const lib of libraries) {
                await getPhysicalFiles(lib.path, physicalFiles);
            }

            const issues = await prisma.issue.findMany();
            const dbPaths = new Set(issues.map(i => i.filePath ? path.normalize(i.filePath).toLowerCase() : ''));
            
            const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_orphans' } });
            let ignoredPaths = new Set<string>();
            if (configSetting?.value) {
                try {
                    const parsed = JSON.parse(configSetting.value);
                    if (Array.isArray(parsed)) ignoredPaths = new Set(parsed.map(p => path.normalize(p).toLowerCase()));
                } catch(e) {}
            }

            const orphans = physicalFiles.filter(p => {
                const normP = path.normalize(p).toLowerCase();
                return !dbPaths.has(normP) && !ignoredPaths.has(normP);
            });

            await prisma.jobLog.create({
                data: {
                    jobType: 'DIAGNOSTICS',
                    status: orphans.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                    durationMs: Date.now() - startTime,
                    message: `Manual Orphan Scan found ${orphans.length} files not indexed in the database.`
                }
            });

            Logger.log(`Manual Orphan Scan complete. Found ${orphans.length} orphaned files.`, orphans.length > 0 ? "warn" : "success");
            return NextResponse.json({ orphans: orphans.map(p => ({ path: p, name: path.basename(p) })) });
        }

        // --- SCAN: ARCHIVE INTEGRITY ---
        if (action === 'scan-integrity') {
            Logger.log("[UI Job] Manual Archive Integrity scan started", "info");
            const issues = await prisma.issue.findMany({ include: { series: true } });
            const corrupted = [];
            
            for (const issue of issues) {
                if (issue.filePath && fs.existsSync(issue.filePath) && issue.filePath.toLowerCase().endsWith('.cbz')) {
                    try {
                        const zip = new AdmZip(issue.filePath);
                        zip.getEntries(); 
                    } catch (e) {
                        corrupted.push({ id: issue.id, name: `${issue.series?.name} #${issue.number}`, path: issue.filePath, error: "Invalid or corrupted zip archive." });
                    }
                }
            }

            // LOG TO DATABASE
            await prisma.jobLog.create({
                data: {
                    jobType: 'DIAGNOSTICS',
                    status: corrupted.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
                    durationMs: Date.now() - startTime,
                    message: `Manual Integrity Scan tested ${issues.length} archives and found ${corrupted.length} corrupted files.`
                }
            });

            Logger.log(`Manual Integrity Scan complete. Found ${corrupted.length} corrupted files.`, corrupted.length > 0 ? "error" : "success");
            return NextResponse.json({ corrupted });
        }

        // --- SCAN: DUPLICATE ISSUES ---
        if (action === 'scan-duplicates') {
            Logger.log("[UI Job] Manual Duplicate scan started", "info");
            const issues = await prisma.issue.findMany({
                where: { filePath: { not: null } },
                include: { series: true }
            });
            
            const dupesMap = new Map<string, any[]>();
            for (const issue of issues) {
                if (!issue.filePath || !fs.existsSync(issue.filePath)) continue;
                const key = `${issue.seriesId}_${issue.number}`;
                if (!dupesMap.has(key)) dupesMap.set(key, []);
                dupesMap.get(key)!.push(issue);
            }
            
            const duplicates = [];
            for (const [key, group] of dupesMap.entries()) {
                if (group.length > 1) {
                    duplicates.push({
                        seriesId: group[0].seriesId,
                        seriesName: group[0].series.name,
                        issueNumber: group[0].number,
                        files: group.map(i => {
                            let size = 0;
                            try { size = fs.statSync(i.filePath).size; } catch(e){}
                            return { id: i.id, path: i.filePath, name: path.basename(i.filePath), size };
                        })
                    });
                }
            }
            
            return NextResponse.json({ duplicates });
        }

        if (action === 'delete-duplicates') {
            const { idsToDelete, deletePhysical } = payload;
            for (const id of idsToDelete) {
                const issue = await prisma.issue.findUnique({ where: { id } });
                if (issue) {
                    if (deletePhysical && issue.filePath && fs.existsSync(issue.filePath)) {
                        await fs.remove(issue.filePath);
                    }
                    await prisma.readProgress.deleteMany({ where: { issueId: id } });
                    await prisma.issue.delete({ where: { id } });
                }
            }
            Logger.log(`Resolved duplicates: Deleted ${idsToDelete.length} records.`, "success");
            return NextResponse.json({ success: true });
        }

        // --- RESOLUTION ACTIONS ---
        if (action === 'delete-ghosts') {
            const { ids, type } = payload; 
            if (type === 'SERIES') {
                await prisma.issue.deleteMany({ where: { seriesId: { in: ids } } });
                await prisma.series.deleteMany({ where: { id: { in: ids } } });
            } else {
                await prisma.readProgress.deleteMany({ where: { issueId: { in: ids } } });
                await prisma.issue.deleteMany({ where: { id: { in: ids } } });
            }
            Logger.log(`Purged ghost ${type} records from database.`, "success");
            return NextResponse.json({ success: true });
        }

        if (action === 'delete-orphans') {
            const { paths } = payload;
            for (const p of paths) {
                if (fs.existsSync(p)) await fs.remove(p);
            }
            Logger.log(`Deleted physical orphaned files from disk.`, "success");
            return NextResponse.json({ success: true });
        }

        if (action === 'ignore-orphans') {
            const { paths } = payload;
            const ignoredSetting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_orphans' } });
            let ignored: string[] = [];
            if (ignoredSetting?.value) {
                try { ignored = JSON.parse(ignoredSetting.value); } catch(e) {}
            }
            
            const newIgnored = Array.from(new Set([...ignored, ...paths]));
            
            await prisma.systemSetting.upsert({
                where: { key: 'ignored_orphans' },
                update: { value: JSON.stringify(newIgnored) },
                create: { key: 'ignored_orphans', value: JSON.stringify(newIgnored) }
            });
            
            Logger.log(`Added ${paths.length} paths to orphan ignore list.`, "success");
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`Diagnostics UI Job Failed: ${getErrorMessage(error)}`, 'error');

        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}