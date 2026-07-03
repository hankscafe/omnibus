// src/app/api/admin/diagnostics/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger'; 
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';
import { UNMATCHED_DIR } from '@/lib/utils/paths';
import { findDuplicateGroups } from '@/lib/duplicate-detector';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const userId = (session.user as any).id;
        const { action, payload } = await request.json();
        const startTime = Date.now();

        // --- RUST OFFLOADED SCAN: GHOST RECORDS ---
        if (action === 'scan-ghosts') {
            Logger.log("[UI Job] Manual Ghost Record scan started via Rust Engine...", "info");
            
            const rustResponse = await fetch(ENGINE_URL + '/api/diagnostics/ghosts', { method: 'POST', headers: engineHeaders() });
            if (!rustResponse.ok) throw new Error(`Rust engine diagnostics endpoint returned status: ${rustResponse.status}`);

            // Re-fetch calculations from DB now that Rust background thread has safely evaluated everything
            const series = await prisma.series.findMany();
            const issues = await prisma.issue.findMany({ include: { series: true } });

            const activeRequests = await prisma.request.findMany({
                where: { status: { notIn: ['COMPLETED', 'IMPORTED', 'CANCELLED'] } },
                select: { volumeId: true }
            });
            const activeReqVolumeIds = new Set(activeRequests.map(r => r.volumeId));

            const ghostSeries = series
                .filter(s => {
                    if (s.folderPath && fs.existsSync(s.folderPath)) return false;
                    if (s.monitored) return false;
                    if (s.metadataId && activeReqVolumeIds.has(s.metadataId)) return false;
                    return true;
                })
                .map(s => ({ id: s.id, type: 'SERIES', name: s.name, path: s.folderPath || 'Missing Path' }));
            
            const ghostIssues = issues
                .filter(i => i.status === 'MISSING') // Rust actively marks missing files as 'MISSING' in the DB
                .map(i => ({ id: i.id, type: 'ISSUE', name: `${i.series?.name} #${i.number}`, path: i.filePath }));

            const totalGhosts = ghostSeries.length + ghostIssues.length;
            Logger.log(`Manual Ghost Scan complete via Rust. Found ${totalGhosts} issues.`, totalGhosts > 0 ? "warn" : "success");

            // The scan is a state mutation (it flips missing issues to status='MISSING' in the engine),
            // so record who ran it and what it flagged — the purge below is already audited, this covers
            // the detection step.
            await AuditLogger.log('GHOST_SCAN', { seriesFlagged: ghostSeries.length, issuesFlaggedMissing: ghostIssues.length }, userId).catch(() => {});

            return NextResponse.json({ ghosts: [...ghostSeries, ...ghostIssues] });
        }

        // --- RUST OFFLOADED SCAN: ORPHANED FILES ---
        if (action === 'scan-orphans') {
            Logger.log("[UI Job] Manual Orphaned File scan started via Rust Engine...", "info");
            
            const rustResponse = await fetch(ENGINE_URL + '/api/diagnostics/orphans', { method: 'POST', headers: engineHeaders() });
            if (!rustResponse.ok) throw new Error(`Rust engine orphan endpoint returned status: ${rustResponse.status}`);
            
            const data = await rustResponse.json();
            const physicalOrphans: string[] = data.orphaned_files || [];

            // Apply global ignore configurations matching original logic rules
            const configSetting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_orphans' } });
            let ignoredPaths = new Set<string>();
            if (configSetting?.value) {
                try {
                    const parsed = JSON.parse(configSetting.value);
                    if (Array.isArray(parsed)) ignoredPaths = new Set(parsed.map(p => path.normalize(p).toLowerCase()));
                } catch(e) {}
            }

            const filteredOrphans = physicalOrphans.filter(p => {
                const normP = path.normalize(p).toLowerCase();
                return !ignoredPaths.has(normP);
            });

            Logger.log(`Manual Orphan Scan complete via Rust. Found ${filteredOrphans.length} orphaned files.`, filteredOrphans.length > 0 ? "warn" : "success");
            return NextResponse.json({ orphans: filteredOrphans.map(p => ({ path: p, name: path.basename(p) })) });
        }

        // --- RUST OFFLOADED SCAN: ARCHIVE INTEGRITY ---
        if (action === 'scan-integrity') {
            Logger.log("[UI Job] Manual Archive Integrity scan started via Rust Engine...", "info");
            
            const rustResponse = await fetch(ENGINE_URL + '/api/diagnostics/integrity', { method: 'POST', headers: engineHeaders() });
            if (!rustResponse.ok) throw new Error(`Rust engine integrity endpoint returned status: ${rustResponse.status}`);

            // Re-fetch corruptions from DB now that Rust has processed file checks concurrently
            const corruptedIssues = await prisma.issue.findMany({
                where: { status: 'CORRUPTED' },
                include: { series: true }
            });

            const corrupted = corruptedIssues.map(i => ({
                id: i.id,
                name: `${i.series?.name} #${i.number}`,
                path: i.filePath,
                error: "Invalid or corrupted zip archive."
            }));

            Logger.log(`Manual Integrity Scan complete via Rust. Found ${corrupted.length} corrupted files.`, corrupted.length > 0 ? "error" : "success");

            // Also a mutation (marks bad archives status='CORRUPTED' in the engine) — audit the run.
            await AuditLogger.log('INTEGRITY_SCAN', { archivesFlaggedCorrupted: corrupted.length }, userId).catch(() => {});

            return NextResponse.json({ corrupted });
        }

        // --- SCAN: DUPLICATE ISSUES (lightweight DB grouping; shared with the dashboard health check) ---
        if (action === 'scan-duplicates') {
            Logger.log("[UI Job] Manual Duplicate scan started", "info");
            const duplicates = await findDuplicateGroups();
            return NextResponse.json({ duplicates });
        }

        if (action === 'delete-duplicates') {
            const { idsToDelete, deletePhysical } = payload;

            // Only ever delete files that live under a configured library root (defense-in-depth: the
            // path comes from the DB, but a corrupted row must never let us rm outside the library).
            const libraries = await prisma.library.findMany();
            const authorizedRoots = libraries
                .map(l => path.resolve(l.path).toLowerCase())
                .map(root => root.endsWith(path.sep) ? root : root + path.sep);
            const isAuthorizedChild = (p: string) => {
                const resolved = path.resolve(p).toLowerCase();
                return authorizedRoots.some(root => resolved.startsWith(root) && resolved.length > root.length);
            };

            let filesDeleted = 0;
            for (const id of idsToDelete) {
                const issue = await prisma.issue.findUnique({ where: { id } });
                if (!issue) continue;
                if (deletePhysical && issue.filePath && fs.existsSync(issue.filePath)) {
                    if (isAuthorizedChild(issue.filePath)) {
                        await fs.remove(issue.filePath);
                        filesDeleted++;
                    } else {
                        Logger.log(`[Diagnostics API] Blocked duplicate file deletion outside library roots: ${issue.filePath}`, 'warn');
                    }
                }
                await prisma.issue.delete({ where: { id } });
            }

            await AuditLogger.log('DELETE_DUPLICATE_ISSUES', { issuesDeleted: idsToDelete, filesDeleted }, userId);
            Logger.log(`Resolved duplicates: removed ${idsToDelete.length} record(s), ${filesDeleted} file(s).`, "success");
            return NextResponse.json({ success: true });
        }

        // --- RESOLUTION ACTIONS ---
        if (action === 'delete-ghosts') {
            const { ids, type } = payload; 
            if (type === 'SERIES') {
                await prisma.series.deleteMany({ where: { id: { in: ids } } });
            } else {
                await prisma.issue.deleteMany({ where: { id: { in: ids } } });
            }
            
            await AuditLogger.log('PURGE_GHOST_RECORDS', { type, idsPurged: ids.length }, userId);
            Logger.log(`Purged ghost ${type} records from database.`, "success");
            return NextResponse.json({ success: true });
        }

        if (action === 'delete-orphans') {
            const { paths } = payload;
            const libraries = await prisma.library.findMany();
            const unmatchedDir = UNMATCHED_DIR;
            
            const authorizedRoots = [
                ...libraries.map(l => path.resolve(l.path).toLowerCase()),
                path.resolve(unmatchedDir).toLowerCase()
            ].map(root => root.endsWith(path.sep) ? root : root + path.sep);

            const deletedPaths = [];

            for (const p of paths) {
                const resolvedTarget = path.resolve(p).toLowerCase();
                const isAuthorizedChild = authorizedRoots.some(root => 
                    resolvedTarget.startsWith(root) && resolvedTarget.length > root.length
                );

                if (isAuthorizedChild) {
                    if (fs.existsSync(p)) {
                        await fs.remove(p);
                        deletedPaths.push(p);
                    }
                } else {
                    Logger.log(`[Diagnostics API] Blocked unauthorized path deletion: ${p}`, 'warn');
                }
            }

            await AuditLogger.log('DELETE_ORPHANED_FILES', { filesDeleted: deletedPaths }, userId);
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
            
            await AuditLogger.log('IGNORE_ORPHANED_FILES', { filesIgnored: paths.length }, userId);
            Logger.log(`Added ${paths.length} paths to orphan ignore list.`, "success");
            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    } catch (error: unknown) {
        Logger.log(`Diagnostics UI Job Failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}