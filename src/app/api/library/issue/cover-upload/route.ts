export const dynamic = 'force-dynamic';

// Admin-only custom cover for a SINGLE issue (the series cover lives in library/cover-upload).
// POST   uploads an image to CONFIG/uploads/issue-covers/<id>.jpg and locks it (hasCustomCover=true),
//        the same shape the Smart Matcher writes, so auto-sync won't overwrite it.
// DELETE resets it: removes the upload, drops the lock, and re-fetches the cover from the metadata
//        provider so a stale/broken custom cover is restored in place (falls back to the series cover).
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

const MAX_BYTES = 15 * 1024 * 1024; // 15MB

async function requireAdminIssue(issueId: unknown) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return { ok: false as const, error: 'Unauthorized', status: 403 };
    if (!issueId || typeof issueId !== 'string') return { ok: false as const, error: 'Missing issue ID', status: 400 };
    const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
    if (!issue) return { ok: false as const, error: 'Issue not found', status: 404 };
    return { ok: true as const, session, issue };
}

// Resolve the issue-cover file path, contained under CONFIG/uploads (guards against a crafted issue id).
function issueCoverPath(issueId: string) {
    const uploadsRoot = path.resolve(CONFIG_DIR, 'uploads');
    const filePath = path.resolve(uploadsRoot, 'issue-covers', `${issueId}.jpg`);
    return { filePath, safe: filePath.startsWith(uploadsRoot + path.sep) };
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const auth = await requireAdminIssue(body?.issueId);
        if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
        const { session, issue } = auth;

        const imageBase64 = body?.imageBase64;
        if (!imageBase64 || typeof imageBase64 !== 'string') return NextResponse.json({ error: 'No image provided' }, { status: 400 });
        const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        if (buffer.length === 0) return NextResponse.json({ error: 'Invalid image data' }, { status: 400 });
        if (buffer.length > MAX_BYTES) return NextResponse.json({ error: 'Image too large (max 15MB)' }, { status: 413 });

        const { filePath, safe } = issueCoverPath(issue.id);
        if (!safe) return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, buffer);

        const coverUrl = `/api/uploads/issue-covers/${issue.id}.jpg?t=${Date.now()}`;
        await prisma.issue.update({ where: { id: issue.id }, data: { coverUrl, hasCustomCover: true } });

        await AuditLogger.log('UPLOAD_ISSUE_COVER', {
            issueId: issue.id,
            issueName: `${issue.series?.name || ''} #${issue.number}`
        }, (session.user as any).id);

        return NextResponse.json({ success: true, coverUrl });
    } catch (error: unknown) {
        Logger.log(`[Issue Cover Upload] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const body = await request.json();
        const auth = await requireAdminIssue(body?.issueId);
        if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
        const { session, issue } = auth;

        // 1. Delete the stale custom-cover upload, if any (best-effort, path-contained).
        try {
            const { filePath, safe } = issueCoverPath(issue.id);
            if (safe && fs.existsSync(filePath)) await fs.promises.unlink(filePath);
        } catch (e) {
            Logger.log(`[Issue Cover Reset] Could not delete upload for ${issue.id}: ${getErrorMessage(e)}`, 'warn');
        }

        // 2. Re-fetch the cover from the metadata provider (instant restore). Falls back to null on failure.
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
                        const { cachedCvGet } = await import('@/lib/metadata/metadata-cache');
                        const res = await cachedCvGet(`https://comicvine.gamespot.com/api/issue/4000-${metadataId}/`, {
                            params: { api_key: setting.value, format: 'json', field_list: 'image' },
                            headers: { 'User-Agent': 'Omnibus/1.0' },
                            timeout: 8000
                        });
                        const image = res.data?.results?.image;
                        newCoverUrl = image?.medium_url || image?.small_url || null;
                    }
                }
            } catch (e) {
                Logger.log(`[Issue Cover Reset] Provider re-fetch failed for ${issue.id}: ${getErrorMessage(e)}`, 'warn');
            }
        }

        // 3. Clear the lock and store the re-fetched cover (or null → the UI falls back to the series cover).
        await prisma.issue.update({ where: { id: issue.id }, data: { coverUrl: newCoverUrl, hasCustomCover: false } });

        await AuditLogger.log('RESET_ISSUE_COVER', {
            issueId: issue.id,
            issueName: `${issue.series?.name || ''} #${issue.number}`,
            restored: !!newCoverUrl
        }, (session.user as any).id);

        return NextResponse.json({ success: true, coverUrl: newCoverUrl });
    } catch (error: unknown) {
        Logger.log(`[Issue Cover Reset] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
