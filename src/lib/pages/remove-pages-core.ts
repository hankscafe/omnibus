// src/lib/pages/remove-pages-core.ts
//
// The page-removal core (issue #189): rewrites an issue's archive without the selected pages and
// re-anchors everything that referenced page positions. Extracted from the Phase 1 route so the
// Phase 3 series sweep (a BullMQ job) runs the IDENTICAL logic per file — same verification, same
// fixups, same audit — without HTTP in between. The engine owns the destructive file work
// (entry-name verification, at-least-one-page floor, temp-write + verify + atomic swap — failures
// leave the original untouched); this core owns identity (issueId → path, never a caller path),
// the DB fixups, and the audit trail. Removing pages SHIFTS every later page index, so:
//   * Issue.pageCount takes the rewritten archive's count (and filePath follows a RAR/7z repack),
//   * ReadProgress.currentPage shifts down by the number of removed pages before it (clamped),
//   * Bookmarks on removed pages are deleted; later ones shift down (ascending order, so the
//     per-user @@unique(userId, issueId, pageIndex) can never collide mid-shift).
// KOReader sync positions are page-based and tolerate the small drift; the reader page cache is
// keyed by entry NAME, so surviving pages stay validly cached.
import fs from 'fs';
import { prisma } from '@/lib/db';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export type RemovePagesOutcome =
    | { ok: true; newPageCount: number; removed: number; convertedToCbz: boolean; issueName: string }
    | { ok: false; status: number; error: string };

export async function removePagesFromIssue(
    issueId: string,
    rawEntryNames: string[],
    actorUserId: string,
    context: 'editor' | 'sweep' = 'editor',
): Promise<RemovePagesOutcome> {
    const entryNames: string[] = [...new Set(rawEntryNames.filter(n => typeof n === 'string' && n.length > 0))];
    if (!issueId) return { ok: false, status: 400, error: "Missing issue ID" };
    if (entryNames.length === 0) return { ok: false, status: 400, error: "No pages selected." };

    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
    if (!issue) return { ok: false, status: 404, error: "Issue not found" };
    if (!issue.filePath || !fs.existsSync(issue.filePath)) {
        return { ok: false, status: 404, error: "This issue has no file on disk." };
    }
    const issueName = `${issue.series?.name || ''} #${issue.number}`;

    // The engine's CURRENT page list is the source of truth — both for validating the caller's
    // marks (a since-changed archive must abort, not delete the wrong page) and for computing
    // the removed INDICES the progress/bookmark fixups below need.
    let pages: string[];
    try {
        const entriesRes = await fetch(ENGINE_URL + '/api/reader/entries', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path: issue.filePath }),
        });
        if (!entriesRes.ok) throw new Error(`engine responded ${entriesRes.status}`);
        const data = await entriesRes.json();
        pages = Array.isArray(data.pages) ? data.pages : [];
    } catch (e) {
        return { ok: false, status: 502, error: "The Rust engine is unreachable — page removal needs it. Check the engine container and try again." };
    }

    const pageSet = new Set(pages);
    const stale = entryNames.filter(n => !pageSet.has(n));
    if (stale.length > 0) {
        return { ok: false, status: 409, error: `${stale.length} selected page(s) no longer exist in this archive — it changed since the pages were listed. Re-open the page view and try again.` };
    }
    if (pages.length - entryNames.length < 1) {
        return { ok: false, status: 400, error: "At least one page must remain. Delete the issue instead if that's the intent." };
    }

    // Ask the engine to rewrite the file. Its refusals (stale list, last page, unsupported
    // format) are actionable messages — pass them through. RAR/7z can't be written back, so
    // removal there repacks the survivors as a sibling .cbz (issue #189 Phase 2) and
    // new_file_path tells us where the issue's file lives now.
    let newPageCount: number;
    let newFilePath: string | null = null;
    try {
        const removeRes = await fetch(ENGINE_URL + '/api/archive/remove-pages', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ file_path: issue.filePath, entry_names: entryNames }),
        });
        const data = await removeRes.json().catch(() => ({}));
        if (!removeRes.ok) {
            const msg = data?.error || `Engine rewrite failed (${removeRes.status}).`;
            return { ok: false, status: removeRes.status === 422 ? 422 : 502, error: msg };
        }
        newPageCount = data.new_page_count;
        if (typeof data.new_file_path === 'string' && data.new_file_path && data.new_file_path !== issue.filePath) {
            newFilePath = data.new_file_path;
        }
    } catch (e) {
        return { ok: false, status: 502, error: "The Rust engine is unreachable — page removal needs it. Check the engine container and try again." };
    }

    // --- Index fixups. The file is already rewritten; these must not be skippable, so they run
    // as one batch transaction (array form — no interleaved work, per the #195 rule).
    const removedIdx = entryNames.map(n => pages.indexOf(n)).sort((a, b) => a - b);
    const removedSet = new Set(removedIdx);
    const countLess = (i: number) => removedIdx.filter(r => r < i).length;
    const lastPage = Math.max(0, newPageCount - 1);

    const progresses = await prisma.readProgress.findMany({ where: { issueId } });
    const bookmarks = await prisma.bookmark.findMany({ where: { issueId } });

    const ops: any[] = [
        prisma.issue.update({
            where: { id: issueId },
            data: { pageCount: newPageCount, ...(newFilePath ? { filePath: newFilePath } : {}) },
        }),
    ];
    for (const p of progresses) {
        // A pointer ON a removed page lands where the next surviving page now sits.
        const newCurrent = Math.min(Math.max(0, p.currentPage - countLess(p.currentPage)), lastPage);
        if (newCurrent !== p.currentPage || p.totalPages !== newPageCount) {
            ops.push(prisma.readProgress.update({
                where: { id: p.id },
                data: { currentPage: newCurrent, totalPages: newPageCount },
            }));
        }
    }
    const doomed = bookmarks.filter(b => removedSet.has(b.pageIndex));
    if (doomed.length > 0) {
        ops.push(prisma.bookmark.deleteMany({ where: { id: { in: doomed.map(b => b.id) } } }));
    }
    const survivors = bookmarks
        .filter(b => !removedSet.has(b.pageIndex))
        .sort((a, b) => a.pageIndex - b.pageIndex);
    for (const b of survivors) {
        const newIndex = b.pageIndex - countLess(b.pageIndex);
        if (newIndex !== b.pageIndex) {
            ops.push(prisma.bookmark.update({ where: { id: b.id }, data: { pageIndex: newIndex } }));
        }
    }
    await prisma.$transaction(ops);

    await AuditLogger.log('REMOVE_PAGES', {
        issueId,
        issueName,
        removedCount: entryNames.length,
        removedPages: entryNames.slice(0, 50),
        newPageCount,
        ...(newFilePath ? { convertedTo: newFilePath } : {}),
        ...(context === 'sweep' ? { viaSweep: true } : {}),
    }, actorUserId);
    Logger.log(`[Pages] Removed ${entryNames.length} page(s) from ${issueName} — ${newPageCount} page(s) remain${newFilePath ? ' (repacked as CBZ)' : ''}${context === 'sweep' ? ' [series sweep]' : ''} (issue #189).`, 'info');

    return { ok: true, newPageCount, removed: entryNames.length, convertedToCbz: !!newFilePath, issueName };
}
