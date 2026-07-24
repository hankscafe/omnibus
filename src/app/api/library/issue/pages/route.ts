// src/app/api/library/issue/pages/route.ts
//
// Page removal (issue #189, Phase 1): rewrites an issue's CBZ without the selected pages and
// re-anchors everything that referenced page positions. The engine owns the destructive file work
// (entry-name verification, at-least-one-page floor, temp-write + verify + atomic swap — failures
// leave the original untouched); this route owns identity (issueId → path, never a client path),
// the DB fixups, and the audit trail. Removing pages SHIFTS every later page index, so:
//   * Issue.pageCount takes the rewritten archive's count,
//   * ReadProgress.currentPage shifts down by the number of removed pages before it (clamped),
//   * Bookmarks on removed pages are deleted; later ones shift down (ascending order, so the
//     per-user @@unique(userId, issueId, pageIndex) can never collide mid-shift).
// KOReader sync positions are page-based and tolerate the small drift; the reader page cache is
// keyed by entry NAME, so surviving pages stay validly cached.
import { NextResponse } from 'next/server';
import fs from 'fs';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await request.json();
        const issueId: string | undefined = body.issueId;
        const entryNames: string[] = Array.isArray(body.entryNames)
            ? [...new Set(body.entryNames.filter((n: any) => typeof n === 'string' && n.length > 0))] as string[]
            : [];
        if (!issueId) return NextResponse.json({ error: "Missing issue ID" }, { status: 400 });
        if (entryNames.length === 0) return NextResponse.json({ error: "No pages selected." }, { status: 400 });

        const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
        if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });
        if (!issue.filePath || !fs.existsSync(issue.filePath)) {
            return NextResponse.json({ error: "This issue has no file on disk." }, { status: 404 });
        }
        const issueName = `${issue.series?.name || ''} #${issue.number}`;

        // The engine's CURRENT page list is the source of truth — both for validating the client's
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
            return NextResponse.json({ error: "The Rust engine is unreachable — page removal needs it. Check the engine container and try again." }, { status: 502 });
        }

        const pageSet = new Set(pages);
        const stale = entryNames.filter(n => !pageSet.has(n));
        if (stale.length > 0) {
            return NextResponse.json({ error: `${stale.length} selected page(s) no longer exist in this archive — it changed since the pages were listed. Re-open the page view and try again.` }, { status: 409 });
        }
        if (pages.length - entryNames.length < 1) {
            return NextResponse.json({ error: "At least one page must remain. Delete the issue instead if that's the intent." }, { status: 400 });
        }

        // Ask the engine to rewrite the file. Its refusals (stale list, last page, non-CBZ) are
        // actionable messages — pass them through.
        let newPageCount: number;
        try {
            const removeRes = await fetch(ENGINE_URL + '/api/archive/remove-pages', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ file_path: issue.filePath, entry_names: entryNames }),
            });
            const data = await removeRes.json().catch(() => ({}));
            if (!removeRes.ok) {
                const msg = data?.error || `Engine rewrite failed (${removeRes.status}).`;
                return NextResponse.json({ error: msg }, { status: removeRes.status === 422 ? 422 : 502 });
            }
            newPageCount = data.new_page_count;
        } catch (e) {
            return NextResponse.json({ error: "The Rust engine is unreachable — page removal needs it. Check the engine container and try again." }, { status: 502 });
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
            prisma.issue.update({ where: { id: issueId }, data: { pageCount: newPageCount } }),
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
        }, (session.user as any).id);
        Logger.log(`[Pages] Removed ${entryNames.length} page(s) from ${issueName} — ${newPageCount} page(s) remain (issue #189).`, 'info');

        return NextResponse.json({ success: true, newPageCount, removed: entryNames.length });
    } catch (error: unknown) {
        Logger.log(`[Pages] Removal failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
