import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger'; // Import the logger

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
            
            const ghostIssues = issues
                .filter(i => !i.filePath || !fs.existsSync(i.filePath))
                .map(i => ({ id: i.id, type: 'ISSUE', name: `${i.series?.name} #${i.number}`, path: i.filePath || 'Missing Path' }));

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
            const configSetting = await prisma.systemSetting.findMany({ where: { key: { in: ['library_path', 'manga_library_path', 'ignored_orphans'] } } });
            const config = Object.fromEntries(configSetting.map(s => [s.key, s.value]));
            
            let physicalFiles: string[] = [];
            if (config.library_path) await getPhysicalFiles(config.library_path, physicalFiles);
            if (config.manga_library_path) await getPhysicalFiles(config.manga_library_path, physicalFiles);

            const issues = await prisma.issue.findMany();
            const dbPaths = new Set(issues.map(i => i.filePath ? path.normalize(i.filePath).toLowerCase() : ''));
            
            let ignoredPaths = new Set<string>();
            if (config.ignored_orphans) {
                try {
                    const parsed = JSON.parse(config.ignored_orphans);
                    if (Array.isArray(parsed)) ignoredPaths = new Set(parsed.map(p => path.normalize(p).toLowerCase()));
                } catch(e) {}
            }

            const orphans = physicalFiles.filter(p => {
                const normP = path.normalize(p).toLowerCase();
                return !dbPaths.has(normP) && !ignoredPaths.has(normP);
            });

            // LOG TO DATABASE
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

    } catch (error: any) {
        Logger.log(`Diagnostics UI Job Failed: ${error.message}`, "error");
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}