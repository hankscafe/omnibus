export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { CONFIG_DIR } from '@/lib/utils/paths';

// Admin: reset a single issue's cover. Clears a stale Smart-Matcher custom cover (deletes the uploaded
// file + drops the hasCustomCover lock that blocks auto-sync) and re-fetches the cover from the metadata
// provider so the real cover returns immediately. If no provider cover is available, coverUrl is nulled
// and the UI falls back to the series cover. Fixes the "one issue shows a broken cover" case.
export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { issueId } = await request.json();
        if (!issueId) return NextResponse.json({ error: "Missing issue ID" }, { status: 400 });

        const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
        if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        // 1. Delete the stale custom-cover upload, if any (best-effort, path-contained).
        try {
            const uploadsRoot = path.resolve(CONFIG_DIR, 'uploads');
            const uploadPath = path.resolve(uploadsRoot, 'issue-covers', `${issueId}.jpg`);
            if (uploadPath.startsWith(uploadsRoot) && fs.existsSync(uploadPath)) {
                await fs.promises.unlink(uploadPath);
            }
        } catch (e) {
            Logger.log(`[Reset Cover] Could not delete upload for ${issueId}: ${getErrorMessage(e)}`, 'warn');
        }

        // 2. Re-fetch the cover from the metadata provider (instant restore). Falls back to null on any failure.
        let newCoverUrl: string | null = null;
        const metadataId = issue.metadataId;
        if (metadataId && !metadataId.startsWith('unmatched_')) {
            try {
                if (issue.metadataSource === 'METRON') {
                    const { MetronProvider } = await import('@/lib/metadata/providers/metron');
                    const details = await new MetronProvider().getIssueDetails(metadataId);
                    newCoverUrl = details.coverUrl || null;
                } else {
                    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    if (setting?.value) {
                        const res = await axios.get(`https://comicvine.gamespot.com/api/issue/4000-${metadataId}/`, {
                            params: { api_key: setting.value, format: 'json', field_list: 'image' },
                            headers: { 'User-Agent': 'Omnibus/1.0' },
                            timeout: 8000
                        });
                        const image = res.data?.results?.image;
                        newCoverUrl = image?.medium_url || image?.small_url || null;
                    }
                }
            } catch (e) {
                Logger.log(`[Reset Cover] Provider cover re-fetch failed for ${issueId}: ${getErrorMessage(e)}`, 'warn');
            }
        }

        // 3. Clear the lock and store the re-fetched cover (or null → the UI falls back to the series cover).
        await prisma.issue.update({
            where: { id: issueId },
            data: { coverUrl: newCoverUrl, hasCustomCover: false }
        });

        await AuditLogger.log('RESET_ISSUE_COVER', {
            issueId,
            issueName: `${issue.series?.name || ''} #${issue.number}`,
            restored: !!newCoverUrl
        }, (session.user as any).id);

        return NextResponse.json({ success: true, coverUrl: newCoverUrl });
    } catch (error: unknown) {
        Logger.log(`[Reset Cover] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
