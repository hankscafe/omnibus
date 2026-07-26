// src/lib/pages/insert-cover-core.ts
//
// Issue #189 follow-up: embeds an uploaded issue cover INTO the archive as its first page, so
// the cover travels with the file (OPDS, Komga/Kavita on the same storage, plain unzipping).
// Shared by the two upload surfaces — the series-page issue-cover upload and the Smart Matcher's
// per-issue covers — so both get identical behavior, fixups, and audit. The engine owns the
// destructive file work (first-sorting entry name, temp-write + verify + atomic swap, RAR/7z →
// sibling-CBZ repack); this core owns identity (issueId → archive + sidecar paths, never a
// caller path), the DB fixups, and the audit trail. Insertion at page 0 SHIFTS every page index
// UP by one, so:
//   * Issue.pageCount takes the rewritten archive's count (and filePath follows a RAR/7z repack),
//   * every ReadProgress.currentPage moves +1 (same content page, new index),
//   * every Bookmark moves +1 — updated in DESCENDING pageIndex order so the per-user
//     @@unique(userId, issueId, pageIndex) can never collide mid-shift (the mirror of
//     removal's ascending rule in remove-pages-core.ts).
// Insert-only by design (Adam's call, 2026-07-26): existing pages are never touched or replaced —
// a superseded baked-in cover is removed with the Page Manager.
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';
import { CONFIG_DIR } from '@/lib/utils/paths';

export type InsertCoverOutcome =
    | { ok: true; newPageCount: number; entryName: string; convertedToCbz: boolean; newFilePath: string | null }
    | { ok: false; status: number; error: string };

// The archive entry's extension should match what the admin actually uploaded — the sidecar is
// always named .jpg regardless of content (historical shape), so sniff the real format.
function detectImageExt(buf: Buffer): 'jpg' | 'png' | 'webp' {
    if (buf.length >= 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString('ascii') === 'PNG') return 'png';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return 'jpg';
}

export async function embedUploadedCoverIntoArchive(
    issueId: string,
    actorUserId: string,
    context: 'upload' | 'matcher' = 'upload',
): Promise<InsertCoverOutcome> {
    if (!issueId) return { ok: false, status: 400, error: 'Missing issue ID' };

    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
    if (!issue) return { ok: false, status: 404, error: 'Issue not found' };
    if (!issue.filePath || !fs.existsSync(issue.filePath)) {
        return { ok: false, status: 404, error: 'This issue has no file on disk — the cover was saved for display only.' };
    }
    // The sidecar the upload just wrote is the single source of the image (CONFIG is a shared
    // mount, so the engine reads the same path — no base64 over the internal wire).
    const sidecarPath = path.join(CONFIG_DIR, 'uploads', 'issue-covers', `${issueId}.jpg`);
    if (!fs.existsSync(sidecarPath)) {
        return { ok: false, status: 404, error: 'No uploaded cover image found for this issue.' };
    }
    const issueName = `${issue.series?.name || ''} #${issue.number}`;
    const imageExt = detectImageExt(await fs.promises.readFile(sidecarPath));

    let newPageCount: number;
    let entryName: string;
    let newFilePath: string | null = null;
    try {
        const res = await fetch(ENGINE_URL + '/api/archive/insert-cover', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ file_path: issue.filePath, image_path: sidecarPath, image_ext: imageExt }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error || `Engine embed failed (${res.status}).`;
            return { ok: false, status: res.status === 422 ? 422 : 502, error: msg };
        }
        newPageCount = data.new_page_count;
        entryName = data.entry_name;
        if (typeof data.new_file_path === 'string' && data.new_file_path && data.new_file_path !== issue.filePath) {
            newFilePath = data.new_file_path;
        }
    } catch {
        return { ok: false, status: 502, error: 'The Rust engine is unreachable — embedding the cover needs it. The cover was still saved for display.' };
    }

    // --- Index fixups. The file is already rewritten; these must not be skippable, so they run
    // as one batch transaction (array form — no interleaved work, per the #195 rule).
    const progresses = await prisma.readProgress.findMany({ where: { issueId } });
    const bookmarks = await prisma.bookmark.findMany({ where: { issueId } });
    const lastPage = Math.max(0, newPageCount - 1);

    const ops: any[] = [
        prisma.issue.update({
            where: { id: issueId },
            data: { pageCount: newPageCount, ...(newFilePath ? { filePath: newFilePath } : {}) },
        }),
    ];
    for (const p of progresses) {
        ops.push(prisma.readProgress.update({
            where: { id: p.id },
            data: { currentPage: Math.min(p.currentPage + 1, lastPage), totalPages: newPageCount },
        }));
    }
    // Descending order: shifting UP means the target index is always still free.
    const descending = [...bookmarks].sort((a, b) => b.pageIndex - a.pageIndex);
    for (const b of descending) {
        ops.push(prisma.bookmark.update({ where: { id: b.id }, data: { pageIndex: b.pageIndex + 1 } }));
    }
    await prisma.$transaction(ops);

    await AuditLogger.log('EMBED_ISSUE_COVER', {
        issueId,
        issueName,
        entryName,
        newPageCount,
        ...(newFilePath ? { convertedTo: newFilePath } : {}),
        ...(context === 'matcher' ? { viaMatcher: true } : {}),
    }, actorUserId);
    Logger.log(`[Pages] Embedded uploaded cover into ${issueName} as ${entryName} — ${newPageCount} page(s)${newFilePath ? ' (repacked as CBZ)' : ''}${context === 'matcher' ? ' [smart matcher]' : ''} (issue #189 follow-up).`, 'info');

    return { ok: true, newPageCount, entryName, convertedToCbz: !!newFilePath, newFilePath };
}
