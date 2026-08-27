// src/app/api/library/series/route.ts

export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { describeIssueFromFilename, normalizeFractionNumbers } from '@/lib/utils/issue-parser';
import { COMIC_EXT_REGEX } from '@/lib/utils/formats';
import { sanitizeDescription, providerWikiBase } from '@/lib/utils/sanitize';
import { safeParse } from '@/lib/utils/safe-parse';
import { getAccessibleLibraryPaths, canAccessPath } from '@/lib/library-access';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const folderPath = searchParams.get('path');
  if (!folderPath) return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });

  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    let userId = (session?.user as any)?.id || null;
    
    if (!userId && session?.user) {
        const user = await prisma.user.findFirst({ where: { OR: [ ...(session.user.email ? [{ email: session.user.email }] : []), ...(session.user.name ? [{ username: session.user.name }] : []) ] } });
        userId = user?.id || null;
    }

    const libraries = await prisma.library.findMany();
    const normalizedTarget = path.normalize(folderPath).replace(/\\/g, '/').toLowerCase();

    const isAuthorized = libraries.some(lib => {
        try {
            const normalizedLibRoot = path.normalize(lib.path).replace(/\\/g, '/').toLowerCase();
            return normalizedTarget.startsWith(normalizedLibRoot);
        } catch(e) {
            return false;
        }
    });

    if (!isAuthorized) return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });

    // Per-library access: the folder must live under a library the user has been granted (admins bypass).
    const accessiblePaths = await getAccessibleLibraryPaths(userId, (session?.user as any)?.role);
    if (!canAccessPath(accessiblePaths, folderPath)) {
        return NextResponse.json({ error: "You don't have access to this library." }, { status: 403 });
    }

    let seriesRecord = await prisma.series.findFirst({ 
        where: { folderPath: folderPath } 
    });

    if (!seriesRecord) {
        const allSeries = await prisma.series.findMany({ select: { id: true, folderPath: true } });
        const matched = allSeries.find(s => 
            s.folderPath && path.normalize(s.folderPath).replace(/\\/g, '/').toLowerCase() === normalizedTarget
        );
        if (matched) {
            seriesRecord = await prisma.series.findUnique({ where: { id: matched.id } });
        }
    }

    if (!seriesRecord) {
        const folderName = path.basename(folderPath);
        const cleanName = folderName.replace(/\s\(\d{4}\)$/, "").trim();
        seriesRecord = await prisma.series.findFirst({
            where: { name: cleanName }
        });
    }

    const folderExists = fs.existsSync(folderPath);

    if (!seriesRecord && !folderExists) {
        return NextResponse.json({ error: "The physical folder is missing and the series is not in the database." }, { status: 404 });
    }

    let isFavorite = false;
    let isFollowing = false;
    const progressMap: Record<string, { readProgress: number, isRead: boolean }> = {};

    if (userId && seriesRecord) {
        const favorite = await prisma.favorite.findUnique({ where: { userId_seriesId: { userId: userId, seriesId: seriesRecord.id } } });
        if (favorite) isFavorite = true;
        const follow = await prisma.seriesFollow.findUnique({ where: { userId_seriesId: { userId: userId, seriesId: seriesRecord.id } } });
        if (follow) isFollowing = true;
        const progresses = await prisma.readProgress.findMany({ where: { userId: userId, issue: { seriesId: seriesRecord.id } }, include: { issue: true } });
        for (const p of progresses) {
            if (p.issue?.filePath) {
                const fileName = path.basename(p.issue.filePath);
                const safeTotal = (p.totalPages && !isNaN(p.totalPages)) ? p.totalPages : 0;
                const safeProgress = (safeTotal > 0) ? (p.currentPage / safeTotal) * 100 : 0;
                progressMap[fileName] = { isRead: p.isCompleted, readProgress: safeProgress };    
            }
        }
    }

    const downloadedIssues: any[] = [];
    const missingIssues: any[] = [];
    const duplicatesList: any[] = [];

    if (seriesRecord) {
        // First pass only needs the fields the dedup ranking + file-sync use — avoid hydrating every
        // wide Issue row twice (the post-reconciliation re-fetch below reads the full rows).
        let existingIssues: any[] = await prisma.issue.findMany({
            where: { seriesId: seriesRecord.id },
            select: { id: true, number: true, isAnnual: true, metadataId: true, filePath: true, attachedVolumeId: true },
        });
        const dbIssueMap = new Map();
        const idsToDelete: string[] = [];

        // #203: the annual domain is part of the grouping key ("annual:1" vs "1") — before this,
        // a co-located "Batman Annual 001" and the real #1 landed in one group and the ranking
        // DELETED one of the rows every visit (row churn). ':' can't appear in a number, so the
        // prefix can't collide with letter-suffixed numbers like "12a".
        const issuesByNum = new Map<string, any[]>();
        for (const issue of existingIssues) {
            const stdNum = issue.number.replace(/^0+(?=\d)/, '');
            const key = `${issue.isAnnual ? 'annual:' : ''}${stdNum}`;
            if (!issuesByNum.has(key)) issuesByNum.set(key, []);
            issuesByNum.get(key)!.push(issue);
        }

        for (const [stdNum, issues] of Array.from(issuesByNum.entries())) {
            // Keep the highest-QUALITY record, not an arbitrary one. The old sort used parseInt(metadataId),
            // but an UNMATCHED row's id is `unmatched_<rand>` → NaN → undefined order, so the MATCHED record
            // (numeric id + real filePath) could be deleted in favor of a placeholder (which cascades to
            // ReadProgress/Bookmark). Rank: matched first, then has-a-file, then higher numeric id (NaN sinks).
            const rank = (i: any): [number, number, number] => {
                const matched = i.metadataId && !String(i.metadataId).startsWith('unmatched') ? 1 : 0;
                const hasFile = i.filePath ? 1 : 0;
                const num = parseInt(i.metadataId);
                return [matched, hasFile, Number.isFinite(num) ? num : -Infinity];
            };
            issues.sort((a, b) => {
                const ra = rank(a), rb = rank(b);
                return (rb[0] - ra[0]) || (rb[1] - ra[1]) || (rb[2] - ra[2]);
            });
            dbIssueMap.set(stdNum, issues[0]);
            // #203 Phase 1: a row belonging to an ATTACHED volume is never a dedupe casualty. Two
            // one-off annual volumes both arriving as "#1" (the Amazing Spider-Man case) are a real,
            // supported state — the user renumbers them to slot chronologically, and until they do,
            // the duplicate warning is the nudge. Deleting one here would destroy a provider link
            // the user made by hand.
            for (let i = 1; i < issues.length; i++) {
                if (issues[i].attachedVolumeId) continue;
                idsToDelete.push(issues[i].id);
            }
        }

        if (idsToDelete.length > 0) {
            await prisma.issue.deleteMany({ where: { id: { in: idsToDelete } } }).catch(() => {});
        }

        const createsToFire: any[] = [];
        const updateOperations: any[] = [];
        const activeFilePaths = new Set();
        const creatingNums = new Set();

        if (folderExists) {
            const files = await fs.promises.readdir(folderPath);

            const filesByNum = new Map<string, { number: string; isAnnual: boolean; files: string[] }>();
            for (const file of files) {
                if (COMIC_EXT_REGEX.test(file)) {
                    // Series-name hint keeps title digits (Kaiju No. 8) out of the issue number —
                    // without it every volume parsed as #8 and collapsed into one dup-flagged row.
                    // #203: files group by (annual domain, number) — "Batman Annual 001" and
                    // "Batman 001" are different slots, not a duplicate pair.
                    const desc = describeIssueFromFilename(file, seriesRecord?.name || undefined);
                    const key = `${desc.isAnnual ? 'annual:' : ''}${desc.number}`;
                    const entry = filesByNum.get(key);
                    if (entry) entry.files.push(file);
                    else filesByNum.set(key, { number: desc.number, isAnnual: desc.isAnnual, files: [file] });
                }
            }

            for (const [key, group] of filesByNum.entries()) {
                if (group.files.length > 1) {
                    duplicatesList.push({
                        issueNumber: group.number,
                        isAnnual: group.isAnnual,
                        files: group.files
                    });
                }

                const file = group.files[0];
                const fullPath = path.join(folderPath, file);
                activeFilePaths.add(fullPath);

                const existingIssue = dbIssueMap.get(key);

                if (existingIssue) {
                    if (existingIssue.filePath !== fullPath) {
                        updateOperations.push(prisma.issue.update({
                            where: { id: existingIssue.id },
                            data: { filePath: fullPath, status: "DOWNLOADED" }
                        }));
                    }
                } else if (!creatingNums.has(key)) {
                    createsToFire.push({
                        seriesId: seriesRecord.id,
                        metadataId: `unmatched_${Math.random()}`,
                        metadataSource: 'LOCAL',
                        matchState: 'UNMATCHED',
                        number: group.number,
                        isAnnual: group.isAnnual,
                        status: "DOWNLOADED",
                        filePath: fullPath
                    });
                    creatingNums.add(key);
                }
            }
        }

        if (createsToFire.length > 0) await prisma.issue.createMany({ data: createsToFire });
        if (updateOperations.length > 0) await Promise.all(updateOperations);

        if (folderExists) {
            await prisma.issue.deleteMany({
                where: {
                    seriesId: seriesRecord.id,
                    metadataId: { startsWith: 'unmatched_' },
                    filePath: { notIn: Array.from(activeFilePaths) as string[] }
                }
            }).catch(() => {});
        }

        existingIssues = await prisma.issue.findMany({ where: { seriesId: seriesRecord.id } });

        // Batch the on-disk existence checks instead of a blocking fs.existsSync per issue — a
        // 1,000-issue series would otherwise stall the Node event loop with 1,000 sync stat calls.
        const existingPaths = new Set<string>();
        await Promise.all(
            existingIssues
                .filter(i => i.filePath)
                .map(async (i) => { try { await fs.promises.access(i.filePath!); existingPaths.add(i.filePath!); } catch { /* gone */ } })
        );

        for (const issue of existingIssues) {
            const fileName = issue.filePath ? path.basename(issue.filePath) : null;
            const prog = fileName && progressMap[fileName] ? progressMap[fileName] : { readProgress: 0, isRead: false };
            
            let finalIssueCoverUrl = issue.coverUrl && (issue.coverUrl.startsWith('http') || issue.coverUrl.match(/^[a-zA-Z]:\\/))
                ? `/api/library/cover?path=${encodeURIComponent(issue.coverUrl)}`
                : issue.coverUrl;
            // Local-first ingest (discussion #182): a file-backed issue with no provider cover shows
            // its own archive's first page instead of inheriting the series cover — the cover route
            // renders it via the engine and falls back to the series cover when it can't.
            if (!finalIssueCoverUrl && issue.filePath && existingPaths.has(issue.filePath)) {
                finalIssueCoverUrl = `/api/library/cover?issueId=${encodeURIComponent(issue.id)}`;
            }

            const formatted = {
                id: issue.id,
                cvId: (issue.metadataId && !issue.metadataId.startsWith('unmatched_')) ? parseInt(issue.metadataId) : null,
                // #203: annuals compose as "Series Annual #N" and carry the flag for the page/OPDS.
                name: issue.name || `${seriesRecord.name}${(issue as any).isAnnual ? ' Annual' : ''} #${issue.number}`,
                isAnnual: (issue as any).isAnnual ?? false,
                // #203 Phase 1: which attached volume this annual belongs to (null = none yet), so
                // the Annuals panel can tell "claimed" apart from "still on its own".
                attachedVolumeId: (issue as any).attachedVolumeId ?? null,
                // Issue #200: normalize vulgar fractions ("½" → 0.5) or parseFloat yields NaN,
                // which serializes to null and turned half-issue requests into "#null" searches.
                // The raw number rides along so the page can always fall back to a real string.
                parsedNum: parseFloat(normalizeFractionNumbers(issue.number)),
                number: issue.number,
                fullPath: issue.filePath,
                coverUrl: finalIssueCoverUrl, 
                writers: safeParse(issue.writers), 
                artists: safeParse(issue.artists), 
                characters: safeParse(issue.characters),
                genres: safeParse((issue as any).genres), 
                storyArcs: safeParse((issue as any).storyArcs), 
                isRead: prog.isRead, 
                readProgress: prog.readProgress
            };

            if (issue.filePath && existingPaths.has(issue.filePath)) downloadedIssues.push(formatted);
            else if (issue.metadataId && !issue.metadataId.startsWith('unmatched_')) missingIssues.push(formatted);
        }
    }

    // #203: annuals read AFTER the main run (Mylar-style), then by number within each domain.
    const domainThenNumber = (a: any, b: any) =>
        ((a.isAnnual ? 1 : 0) - (b.isAnnual ? 1 : 0)) || ((a.parsedNum ?? 0) - (b.parsedNum ?? 0));
    downloadedIssues.sort(domainThenNumber);
    missingIssues.sort(domainThenNumber);
    
    const finalSeriesCoverUrl = seriesRecord?.coverUrl && (seriesRecord.coverUrl.startsWith('http') || seriesRecord.coverUrl.match(/^[a-zA-Z]:\\/))
        ? `/api/library/cover?path=${encodeURIComponent(seriesRecord.coverUrl)}` 
        : seriesRecord?.coverUrl || null;

    // --- NEW: Inject metadataId and metadataSource to fully support Metron routing on the frontend ---
    return NextResponse.json({
      id: seriesRecord?.id || null,
      isFavorite,
      isFollowing,
      cvId: (seriesRecord?.metadataId && !seriesRecord.metadataId.startsWith('unmatched_')) ? parseInt(seriesRecord.metadataId) : null,
      metadataId: seriesRecord?.metadataId || null,
      metadataSource: seriesRecord?.metadataSource || 'COMICVINE',
      seriesName: seriesRecord?.name?.trim() || path.basename(folderPath).replace(/\s\(\d{4}\)$/, ""),
      publisher: seriesRecord?.publisher || null, 
      year: seriesRecord?.year || null,
      status: seriesRecord?.status || null,
      bookType: seriesRecord?.bookType || null,
      monitored: seriesRecord?.monitored || false,
      isManga: seriesRecord?.isManga || false,
      // Sanitize provider HTML before it reaches the dangerouslySetInnerHTML synopsis sink (stored
      // XSS), resolving provider-relative wiki links so they stop 404ing on the Omnibus origin.
      description: sanitizeDescription(seriesRecord?.description, providerWikiBase(seriesRecord?.metadataSource)) || null,
      universe: seriesRecord?.universe || null,
      // Series-level genres (Metron genres / CV volume concepts, issue #180) — JSON array string in the DB.
      genres: safeParse((seriesRecord as any)?.genres),
      seriesGroup: (seriesRecord as any)?.seriesGroup || null,
      matchState: seriesRecord?.matchState || 'UNMATCHED',
      path: folderPath,
      coverUrl: finalSeriesCoverUrl,
      hasCustomCover: (seriesRecord as any)?.hasCustomCover || false,
      // Manual-edits lock state — the metadata editor shows it and offers the unlock (issue #194 (f)).
      hasCustomMetadata: (seriesRecord as any)?.hasCustomMetadata || false,
      // #199 ComicInfo defaults for the series editor: raw scalars, list columns as parsed arrays
      // (the editor joins them for display), blackAndWhite as the tri-state boolean|null.
      comicInfo: {
        imprint: (seriesRecord as any)?.imprint || null,
        format: (seriesRecord as any)?.format || null,
        languageISO: (seriesRecord as any)?.languageISO || null,
        ageRating: (seriesRecord as any)?.ageRating || null,
        communityRating: (seriesRecord as any)?.communityRating ?? null,
        blackAndWhite: (seriesRecord as any)?.blackAndWhite ?? null,
        gtin: (seriesRecord as any)?.gtin || null,
        notes: (seriesRecord as any)?.notes || null,
        scanInformation: (seriesRecord as any)?.scanInformation || null,
        review: (seriesRecord as any)?.review || null,
        mainCharacterOrTeam: (seriesRecord as any)?.mainCharacterOrTeam || null,
        alternateSeries: (seriesRecord as any)?.alternateSeries || null,
        alternateNumber: (seriesRecord as any)?.alternateNumber || null,
        alternateCount: (seriesRecord as any)?.alternateCount ?? null,
        storyArcNumber: (seriesRecord as any)?.storyArcNumber || null,
        // genres also lives top-level (older consumers); duplicated here so the editor's seed →
        // save round-trip can't clear a provider-synced value it never displayed.
        genres: safeParse((seriesRecord as any)?.genres),
        writers: safeParse((seriesRecord as any)?.writers),
        artists: safeParse((seriesRecord as any)?.artists),
        coverArtists: safeParse((seriesRecord as any)?.coverArtists),
        colorists: safeParse((seriesRecord as any)?.colorists),
        letterers: safeParse((seriesRecord as any)?.letterers),
        characters: safeParse((seriesRecord as any)?.characters),
        teams: safeParse((seriesRecord as any)?.teams),
        locations: safeParse((seriesRecord as any)?.locations),
        storyArcs: safeParse((seriesRecord as any)?.storyArcs),
        inker: safeParse((seriesRecord as any)?.inker),
        editor: safeParse((seriesRecord as any)?.editor),
        translator: safeParse((seriesRecord as any)?.translator),
        tags: safeParse((seriesRecord as any)?.tags),
      },
      downloadedIssues, 
      missingIssues,
      duplicates: duplicatesList
    });

  } catch (error: any) {
    Logger.log(`[Series API] Fatal Error: ${error.message}`, 'error');
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        
        const { seriesIds, deleteFiles } = await request.json();
        const seriesToDelete = await prisma.series.findMany({ where: { id: { in: seriesIds } } });
        
        await prisma.issue.deleteMany({ where: { seriesId: { in: seriesIds } } });
        await prisma.series.deleteMany({ where: { id: { in: seriesIds } } });
        
        const deletedPaths = [];
        if (deleteFiles) {
            for (const series of seriesToDelete) {
                if (series.folderPath && fs.existsSync(series.folderPath)) {
                    await fs.remove(series.folderPath);
                    deletedPaths.push(series.folderPath);
                }
            }
        }

        await AuditLogger.log('DELETE_SERIES', {
            seriesIds,
            seriesNames: seriesToDelete.map(s => s.name),
            deletedPhysicalFiles: deleteFiles,
            deletedPaths
        }, (session.user as any).id);

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Library Series API] Delete Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
    }
}