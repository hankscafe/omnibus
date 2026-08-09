// src/app/api/library/match-series/route.ts
import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { detectManga } from '@/lib/manga-detector';
import { DiscordNotifier } from '@/lib/discord'; 
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger'; 
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { AuditLogger } from '@/lib/audit-logger';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getServerSession } from 'next-auth/next';
import { omnibusQueue } from '@/lib/queue';
import { extractIssueNumber, normalizeFractionNumbers } from '@/lib/utils/issue-parser';
import { COMIC_EXTENSIONS } from '@/lib/utils/formats';
import { sanitizeFilename } from '@/lib/utils/sanitize';
import { UNMATCHED_DIR, CONFIG_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { safeRelocateFolder, moveFileSafe, ensureLibraryDir } from '@/lib/utils/safe-fs';
import { comicInfoDefaultsUpdateFragment } from '@/lib/utils/comicinfo-fields';
import { countArchivePages } from '@/lib/utils/archive-pages';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';
import { findLocalCoverBasename } from '@/lib/utils/cover-plan';
import { parseComicVineCredits } from '@/lib/utils';

// #199 round 4 Beta B: only non-empty credit groups become columns (never write a literal '[]' —
// issue #179), stringified to the Issue JSON-array convention.
const creditColumns = (groups: Record<string, string[] | undefined>): Record<string, string> =>
    Object.fromEntries(
        Object.entries(groups)
            .filter(([, v]) => Array.isArray(v) && v.length > 0)
            .map(([k, v]) => [k, JSON.stringify(v)])
    );

// #199 round 4 Beta B: the lock-pairs-with-credits rule. An admin-titled issue gets locked so
// syncs can't overwrite the title — but a row-level lock also excludes the issue from credit
// enrichment, so the credits must land IN THE SAME WRITE. Returns the credit columns on success
// (possibly {} when the provider genuinely has none — locking is then harmless), or null when the
// fetch failed — the caller then writes the title WITHOUT the lock rather than starving the issue.
async function fetchIssueCreditsForImport(provider: string, issueMetaId: string): Promise<Record<string, string> | null> {
    try {
        if (provider === 'METRON') {
            const detail = await new MetronProvider().getIssueDetails(issueMetaId);
            return creditColumns({
                writers: detail.writers, artists: detail.artists, coverArtists: detail.coverArtists,
                colorists: detail.colorists, letterers: detail.letterers, inker: detail.inker,
                editor: detail.editor, translator: detail.translator, characters: detail.characters,
                teams: detail.teams, locations: detail.locations, storyArcs: detail.storyArcs,
            });
        }
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        if (!setting?.value || setting.value === '********') return null;
        const res = await cachedCvGet(`https://comicvine.gamespot.com/api/issue/4000-${issueMetaId}/`, {
            params: {
                api_key: setting.value, format: 'json',
                field_list: 'person_credits,character_credits,team_credits,location_credits,story_arc_credits,concepts',
            },
        });
        const d = res.data?.results;
        if (!d) return null;
        const p = parseComicVineCredits(d.person_credits, d.character_credits, d.concepts, d.story_arc_credits, d.team_credits, d.location_credits);
        return creditColumns({
            writers: p.writers, artists: p.artists, coverArtists: p.coverArtists, colorists: p.colorists,
            letterers: p.letterers, inker: p.inkers, editor: p.editors, translator: p.translators,
            characters: p.characters, teams: p.teams, locations: p.locations, storyArcs: p.storyArcs,
        });
    } catch (e) {
        Logger.log(`[Match Series] Issue-credit fetch failed for ${provider} ${issueMetaId}: ${getErrorMessage(e)} — the title will be written unlocked.`, 'warn');
        return null;
    }
}

export async function POST(request: Request) {
  try {
    // Smart Matcher: provider re-match, folder relocate/merge, file renames, DB mutation, job enqueues.
    // Middleware only role-gates /api/admin/*, so enforce admin here before any destructive work.
    const session = await getServerSession(await getAuthOptions());
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    const req = (await request.json()) as any;
    const { oldFolderPath, cvId, metadataId, metadataSource, name, year, publisher, exactIssueId, exactIssueNumber,
            universe, seriesGroup, description, lockMetadata, writeToFile, coverImageBase64, issueCoverImageBase64, issueCoverEmbed,
            dataMode, issueTitle } = req;

    const targetMetaId = metadataId ? metadataId.toString() : (cvId ? cvId.toString() : null);
    const targetSource = metadataSource || 'COMICVINE';

    if (!oldFolderPath || !targetMetaId) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    Logger.log(`[Match Series Debug] Starting manual match. ID: ${targetMetaId} | Source: ${targetSource} | Path: ${oldFolderPath}`, 'debug');

    const libraries = await prisma.library.findMany();
    const unmatchedDir = UNMATCHED_DIR;

    // Separator-safe containment so a sibling-prefix path can't pass (consistency with cover/reader routes).
    if (!isPathWithinRoots(oldFolderPath, [...libraries.map(l => l.path), unmatchedDir])) {
        return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    }
    if (!fs.existsSync(oldFolderPath)) return NextResponse.json({ error: "File/Folder not found." }, { status: 404 });

    let realPublisher = publisher && publisher !== 'Unknown' && publisher !== 'Other' ? publisher : '';
    let realName = name && name !== 'Unknown Series' ? name : '';
    let realYear = year ? parseInt(year) : 0;
    let imageUrl = null;
    let status = 'Ongoing'; 
    
    try {
        if (targetSource === 'METRON') {
            Logger.log(`[Match Series Debug] Routing API request to Metron.Cloud for Series ID: ${targetMetaId}...`, 'debug');
            const metron = new MetronProvider();
            const details = await metron.getSeriesDetails(targetMetaId);
            if (details) {
                Logger.log(`[Match Series Debug] Metron Fetch Success: Found "${details.name}" (${details.year})`, 'debug');
                if (!realPublisher) realPublisher = details.publisher;
                if (!realName) realName = details.name;
                if (!realYear) realYear = details.year;
                imageUrl = details.coverUrl;
                status = details.status;
            } else {
                Logger.log(`[Match Series Debug] Metron Fetch Failed: Series ID ${targetMetaId} returned null.`, 'warn');
            }
        } else {
            Logger.log(`[Match Series Debug] Routing API request to ComicVine for Volume ID: ${targetMetaId}...`, 'debug');
            const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            const cvApiKey = cvKeySetting?.value;
            if (cvApiKey) {
                const cvVolRes = await cachedCvGet(`https://comicvine.gamespot.com/api/volume/4050-${targetMetaId}/`, {
                    params: { api_key: cvApiKey, format: 'json', field_list: 'publisher,name,start_year,image,end_year' },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 4000
                });
                if (cvVolRes.data?.results) {
                    const vol = cvVolRes.data.results;
                    Logger.log(`[Match Series Debug] ComicVine Fetch Success: Found "${vol.name}" (${vol.start_year})`, 'debug');
                    if (!realPublisher && vol.publisher?.name) realPublisher = vol.publisher.name;
                    if (!realName && vol.name) realName = vol.name;
                    if (!realYear && vol.start_year) realYear = parseInt(vol.start_year) || 0;
                    imageUrl = vol.image?.medium_url || vol.image?.super_url;
                    if (vol.end_year) status = 'Ended'; 
                } else {
                    Logger.log(`[Match Series Debug] ComicVine Fetch Failed: No results returned for ID ${targetMetaId}.`, 'warn');
                }
            } else {
                Logger.log(`[Match Series Debug] Skipped ComicVine fetch due to missing API key.`, 'warn');
            }
        }
    } catch(e: unknown) {
        Logger.log(`[Match Series Debug] Metadata Fetch Exception: ${getErrorMessage(e)}`, 'error');
    }

    if (!realName) realName = path.basename(oldFolderPath).replace(/\s\(\d{4}\)$/, "").trim(); 
    if (!realPublisher) realPublisher = 'Other';

    const safePublisher = sanitizeFilename(realPublisher);
    const safeName = sanitizeFilename(realName);
    const safeYear = realYear > 0 ? realYear.toString() : '';
    // {UniverseName}/{SeriesGroup} are admin-supplied (the Smart Matcher metadata editor) — providers
    // don't reliably expose them. Sanitized here so they can build folder/file paths like every other token.
    const safeUniverse = universe ? sanitizeFilename(universe) : '';
    const safeSeriesGroup = seriesGroup ? sanitizeFilename(seriesGroup) : '';
    
    // The records are fetched BEFORE the manga decision — they carry the prior signals.
    let existingRecord = await prisma.series.findUnique({
        where: {
            metadataSource_metadataId: {
                metadataSource: targetSource,
                metadataId: targetMetaId
            }
        }
    });

    const unmatchedRecord = await prisma.series.findFirst({
        where: { folderPath: oldFolderPath }
    });

    // NEVER-DEMOTE manga resolution (2026-07-25 worklist item 5): a context-free re-detection from
    // name+publisher+year used to overwrite isManga and physically move manga-library series into
    // the Comics library on every match. The admin's library placement and any existing DB rows are
    // stronger signals than a detection run with no file in hand — detection now runs only when no
    // prior signal exists, so it can PROMOTE but never demote.
    const sourceLibrary = libraries.find(l => l.id === (unmatchedRecord?.libraryId || existingRecord?.libraryId));
    const priorMangaSignal = !!(existingRecord?.isManga || unmatchedRecord?.isManga || sourceLibrary?.isManga);
    const isManga = priorMangaSignal || await detectManga({ name: safeName, publisher: { name: realPublisher }, year: realYear });

    // Library placement: when the series already lives in a library of the right type, KEEP it there
    // (a re-match must not shuttle it between same-type libraries); move only on promotion or when it
    // has no library yet.
    let targetLib = (sourceLibrary && sourceLibrary.isManga === isManga)
        ? sourceLibrary
        : (isManga
            ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
            : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga));

    if (!targetLib) targetLib = libraries[0];
    if (!targetLib) return NextResponse.json({ error: "No libraries configured." }, { status: 400 });

    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";

    const relFolderPath = folderPattern
        .replace(/{Publisher}/gi, safePublisher || "Other")
        .replace(/{Series}/gi, safeName || "Unknown Series")
        .replace(/{Year}/gi, safeYear)
        .replace(/{VolumeYear}/gi, safeYear)
        .replace(/{UniverseName}/gi, safeUniverse)
        .replace(/{SeriesGroup}/gi, safeSeriesGroup)
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
    const newFolderPath = path.join(targetLib.path, ...folderParts).replace(/\\/g, '/');

    const pubDir = path.dirname(newFolderPath);
    // ensureLibraryDir = mkdir + the operator's UMASK-derived folder mode (#199 read-only folders).
    if (!fs.existsSync(pubDir)) await ensureLibraryDir(pubDir);

    // Cover precedence: an admin can supply a custom cover in the Smart Matcher editor (hasNewCustomCover);
    // otherwise an already-custom series keeps its cover (keepExistingCustomCover) — a manual re-match must
    // not overwrite cover.jpg or repoint coverUrl at the provider art.
    const hasNewCustomCover = typeof coverImageBase64 === 'string' && coverImageBase64.length > 0;
    const keepExistingCustomCover = !hasNewCustomCover && !!(existingRecord?.hasCustomCover || unmatchedRecord?.hasCustomCover);

    // cover_source policy (issue #194 follow-up): in 'archive' mode an existing local/extracted
    // cover file wins over provider art — the same gate the engine's resolve_cover applies, which
    // this route used to bypass by always stamping the provider image over cover.jpg. Probe the
    // target folder first (a merge keeps its files), then the source (its cover travels with the
    // move; a loose-file source path simply never matches).
    const coverSource = config.cover_source || 'metadata';
    const localCoverBasename = coverSource === 'archive' ? findLocalCoverBasename(newFolderPath, oldFolderPath) : null;
    const archiveKeepsLocalCover = !hasNewCustomCover && !!localCoverBasename;

    const updateData = {
        cvId: targetSource === 'COMICVINE' ? parseInt(targetMetaId) : null,
        metadataId: targetMetaId,
        metadataSource: targetSource,
        matchState: 'MATCHED',
        // DB keeps the RAW provider/admin name — sanitizeFilename is for path building only.
        // Writing the sanitized copy here stripped characters like ':' that the next provider
        // sync restored, so the series name flip-flopped between forms (issue #194).
        name: realName,
        year: realYear,
        publisher: realPublisher,
        folderPath: newFolderPath,
        isManga: isManga,
        status: status,
        libraryId: targetLib.id,
        ...(hasNewCustomCover
            ? { coverUrl: `/api/library/cover?path=${encodeURIComponent(path.join(newFolderPath, 'cover.jpg'))}&v=${Date.now()}`, hasCustomCover: true }
            : keepExistingCustomCover
                ? {}
                : archiveKeepsLocalCover
                    ? { coverUrl: `/api/library/cover?path=${encodeURIComponent(path.join(newFolderPath, localCoverBasename!))}` }
                    : { coverUrl: imageUrl ? `/api/library/cover?path=${encodeURIComponent(path.join(newFolderPath, 'cover.jpg'))}` : null }),
        // Admin-supplied descriptive metadata from the Smart Matcher editor. Stored raw (paths use the
        // sanitized copies above). lockMetadata sets hasCustomMetadata so the post-match provider sync
        // can't revert the admin's entries — same contract as the rich metadata editor (library/update).
        ...(universe !== undefined ? { universe: universe || null } : {}),
        ...(seriesGroup !== undefined ? { seriesGroup: seriesGroup || null } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        // #199 ComicInfo defaults — the shared fragment (also used by the series editor's
        // library/update) applies the undefined-means-untouched contract, list-to-JSON-array
        // conversion, number validation, and the two-way B&W semantics in one place.
        ...comicInfoDefaultsUpdateFragment(req),
        ...(lockMetadata ? { hasCustomMetadata: true } : {})
    };

    if (existingRecord) {
        if (unmatchedRecord && unmatchedRecord.id !== existingRecord.id) {
            await prisma.issue.updateMany({
                where: { seriesId: unmatchedRecord.id },
                data: { seriesId: existingRecord.id }
            });
            await prisma.series.delete({ where: { id: unmatchedRecord.id } }).catch(() => {});
        }
        
        existingRecord = await prisma.series.update({
            where: { id: existingRecord.id },
            data: updateData
        });
    } else if (unmatchedRecord) {
        existingRecord = await prisma.series.update({
            where: { id: unmatchedRecord.id },
            data: updateData
        });
    } else {
        existingRecord = await prisma.series.create({ data: updateData });
    }

    DiscordNotifier.sendAlert('metadata_match', {
        title: realName, publisher: realPublisher, year: realYear.toString(), imageUrl: imageUrl, user: "Admin"
    }).catch(() => {});

    const oldStat = await fs.promises.stat(oldFolderPath);
    const isFile = oldStat.isFile();

    // Count duplicate files we refuse to overwrite (parity with the Standardize-names route). A non-zero
    // count is returned + logged so a dupe is preserved instead of silently clobbered.
    let conflicts = 0;
    // True when a loose file couldn't be placed because a same-named file was already in the target —
    // the matching file in the folder is then NOT ours, so the rename loop must leave it alone.
    let looseFileConflict = false;

    let activeFolderPath = oldFolderPath;
    if (isFile) {
        if (!fs.existsSync(newFolderPath)) {
            await ensureLibraryDir(newFolderPath);
        }
        activeFolderPath = newFolderPath;
        const targetFilePath = path.join(newFolderPath, path.basename(oldFolderPath));
        // Never overwrite a different file already sitting at the destination — leave the loose file where it is.
        if (fs.existsSync(targetFilePath) && path.normalize(targetFilePath).toLowerCase() !== path.normalize(oldFolderPath).toLowerCase()) {
            Logger.log(`[Match Series] Conflict: "${path.basename(targetFilePath)}" already exists in the target folder; left the source file in place: ${oldFolderPath}`, 'warn');
            conflicts++;
            looseFileConflict = true;
        } else {
            // Cross-device-safe: /unmatched and the library are separate mounts in most Docker setups,
            // where a raw rename dies with EXDEV (discussion #169).
            await moveFileSafe(oldFolderPath, targetFilePath);
        }
    } else if (path.normalize(oldFolderPath).toLowerCase() !== path.normalize(newFolderPath).toLowerCase()) {
        // Non-destructive folder relocate/merge: a pre-existing target is merged into, never deleted, and
        // any colliding file is left in place + counted (safeRelocateFolder also handles a plain move when
        // the destination doesn't exist, and cleans up the emptied source folder).
        const srcRoot = [...libraries.map(l => l.path), unmatchedDir]
            .find(r => path.normalize(oldFolderPath).toLowerCase().startsWith(path.normalize(r).toLowerCase()))
            || path.dirname(oldFolderPath);
        const { conflicts: folderConflicts } = await safeRelocateFolder(oldFolderPath, newFolderPath, srcRoot);
        conflicts += folderConflicts;
        activeFolderPath = newFolderPath;
    }

    try {
        const files = await fs.promises.readdir(activeFolderPath);
        
        for (const file of files) {
            const rawExt = path.extname(file);
            if (COMIC_EXTENSIONS.includes(rawExt.toLowerCase())) {
                const oldName = path.basename(file, rawExt);
                let finalExt = rawExt.toLowerCase();
                let issueNumStr = "";
                let targetIssueMetaId = null;
                
                // --- NEW: Magic Number Check! Fix fake CBRs directly in the Matcher ---
                if (finalExt === '.cbr') {
                    try {
                        const buffer = Buffer.alloc(4);
                        const fd = await fs.promises.open(path.join(activeFolderPath, file), 'r');
                        await fd.read(buffer, 0, 4, 0);
                        await fd.close();
                        if (buffer.toString('hex') === '504b0304') {
                            finalExt = '.cbz';
                            Logger.log(`[Match Series Debug] Fake CBR detected for ${file}. Correcting to .cbz`, 'debug');
                        }
                    } catch (e) {}
                }

                // 1. Identify if this is the EXACT file we clicked in the UI
                const isTargetFile = path.basename(file) === path.basename(oldFolderPath);
                
                // Skip adjacent files to prevent accidental ghost records
                if (!isTargetFile) {
                    continue;
                }

                // The loose file was left in place due to a name collision — the file matching this name
                // in the folder is the pre-existing one, so never touch it.
                if (looseFileConflict) {
                    continue;
                }
                
                Logger.log(`[Match Series Debug] Evaluating exact target file for rename: "${file}"`, 'debug');
                
                // Proceed with exact overrides
                if (exactIssueNumber) {
                    issueNumStr = exactIssueNumber;
                    targetIssueMetaId = exactIssueId || null;
                    Logger.log(`[Match Series Debug] Using exact issue override: ${issueNumStr}`, 'debug');
                } else {
                    issueNumStr = extractIssueNumber(file, realName);
                    Logger.log(`[Match Series Debug] Extracted issue '${issueNumStr}' via auto-extraction.`, 'debug');
                }
                
                if (issueNumStr) {
                    // Issue #200: a raw "½" is length 1 and would pad to "0½" — normalize first so
                    // filenames and the DB row both say "0.5".
                    issueNumStr = normalizeFractionNumbers(issueNumStr);
                    let formattedNum = issueNumStr;
                    if (!issueNumStr.includes('.') && issueNumStr.length === 1) formattedNum = `0${issueNumStr}`;
                    
                    const filePatternToUse = isManga 
                        ? (config.manga_file_naming_pattern || "{Series} Vol. {Issue}")
                        : (config.file_naming_pattern || "{Series} #{Issue}");
                        
                    const issueYear = existingRecord ? (existingRecord.year?.toString() || safeYear) : safeYear;
                        
                    // Use finalExt so the rename applies the verified extension
                    const newFileName = filePatternToUse
                        .replace(/{Publisher}/gi, safePublisher || "Other")
                        .replace(/{Series}/gi, safeName)
                        .replace(/{Year}/gi, safeYear)
                        .replace(/{VolumeYear}/gi, safeYear)
                        .replace(/{IssueYear}/gi, issueYear)
                        .replace(/{Issue}/gi, formattedNum)
                        .replace(/{UniverseName}/gi, safeUniverse)
                        .replace(/{SeriesGroup}/gi, safeSeriesGroup)
                        .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\s+/g, ' ').trim() + finalExt;
                    
                    const oldFilePath = path.join(activeFolderPath, file);
                    const newFilePath = path.join(activeFolderPath, newFileName);

                    // 1. Handle OS Rename — never overwrite a different existing file (case-only differences
                    //    are treated as already-correct). On a real collision, leave the duplicate in place,
                    //    restore a loose file to /unmatched so nothing is half-imported, and skip the DB write.
                    if (path.normalize(oldFilePath).toLowerCase() !== path.normalize(newFilePath).toLowerCase()) {
                        if (fs.existsSync(newFilePath)) {
                            Logger.log(`[Match Series] Conflict: "${newFileName}" already exists in the target folder; not overwriting.`, 'warn');
                            conflicts++;
                            if (isFile) { try { await moveFileSafe(oldFilePath, oldFolderPath); } catch (e) {} }
                            continue;
                        }
                        Logger.log(`[Match Series Debug] Executing OS File Rename: ${file} -> ${newFileName}`, 'debug');
                        await moveFileSafe(oldFilePath, newFilePath);
                    }

                    // 2. Inline Database Update (No more silent transaction rollbacks!)
                    if (existingRecord) {
                        const updatePayload: any = {
                            filePath: newFilePath,
                            number: issueNumStr,
                            seriesId: existingRecord.id,
                            // Persist the page total so OPDS (pse:count) can stream this issue.
                            pageCount: await countArchivePages(newFilePath)
                        };
                        
                        if (isTargetFile && targetIssueMetaId) {
                            updatePayload.metadataId = targetIssueMetaId.toString(); // Force string to prevent DB crashes
                            updatePayload.metadataSource = targetSource; 
                            updatePayload.matchState = 'MATCHED';
                        }

                        try {
                            const existingIssue = await prisma.issue.findFirst({
                                where: { seriesId: existingRecord.id, number: issueNumStr }
                            });

                            let finalIssueId;

                            if (existingIssue) {
                                const updated = await prisma.issue.update({
                                    where: { id: existingIssue.id },
                                    data: updatePayload
                                });
                                finalIssueId = updated.id;
                                Logger.log(`[Match Series Debug] DB Updated successfully for Issue ${issueNumStr}`, 'debug');
                            } else {
                                const created = await prisma.issue.create({
                                    data: {
                                        ...updatePayload,
                                        name: `Issue ${issueNumStr}`
                                    }
                                });
                                finalIssueId = created.id;
                                Logger.log(`[Match Series Debug] DB Created successfully for Issue ${issueNumStr}`, 'debug');
                            }

                            // --- Trigger the Auto-Converter for genuine CBRs and CB7s (unless disabled —
                            //     native RAR reading serves unconverted .cbr/.rar via the engine) ---
                            if ((finalExt === '.cbr' || finalExt === '.cb7' || finalExt === '.rar') && finalIssueId) {
                                const conversionEnabled = (await prisma.systemSetting.findUnique({ where: { key: 'cbr_conversion_enabled' } }))?.value !== 'false';
                                if (conversionEnabled) {
                                    Logger.log(`[Match Series Debug] Convertible archive detected. Queueing conversion for Issue ${finalIssueId}...`, 'debug');

                                    await omnibusQueue.add('CBR_CONVERSION',
                                        { type: 'CBR_CONVERSION', issueId: finalIssueId },
                                        { jobId: `CBR_CONVERSION_${finalIssueId}_${Date.now()}` }
                                    );
                                } else {
                                    Logger.log(`[Match Series Debug] CBR conversion disabled — keeping ${finalExt} for native reading.`, 'debug');
                                }
                            }

                            // #199 round 4 Beta B: the issue's own title (file-prefilled in keep mode,
                            // or admin-typed). Lock pairs with credits: with an exact provider id the
                            // credits land in the same write and the row locks (syncs then preserve
                            // everything, and the locked row never needed enrichment). Without an id —
                            // or when the credit fetch fails — the title writes UNLOCKED so the issue
                            // can still be enriched; the name-precedence guard (beta.007) keeps list
                            // composites from clobbering a real title either way.
                            if (issueTitle && String(issueTitle).trim() && finalIssueId) {
                                const titleVal = String(issueTitle).trim();
                                const credits = targetIssueMetaId
                                    ? await fetchIssueCreditsForImport(targetSource, targetIssueMetaId.toString())
                                    : null;
                                await prisma.issue.update({
                                    where: { id: finalIssueId },
                                    data: { name: titleVal, ...(credits !== null ? { hasCustomMetadata: true, ...credits } : {}) },
                                }).catch(e => Logger.log(`[Match Series] Failed to write the issue title: ${getErrorMessage(e)}`, 'warn'));
                                Logger.log(`[Match Series] Issue title "${titleVal}" written${credits !== null ? ` + locked with ${Object.keys(credits).length} provider credit group(s)` : ' (unlocked — no exact id or the credit fetch failed)'}.`, 'info');
                            }

                            // --- Per-issue custom cover from the Smart Matcher — written keyed by issue id
                            //     (in CONFIG/uploads, like avatars) + hasCustomCover so the sync never clobbers it.
                            if (issueCoverImageBase64 && finalIssueId) {
                                try {
                                    const coversDir = path.join(CONFIG_DIR, 'uploads', 'issue-covers');
                                    await fs.promises.mkdir(coversDir, { recursive: true });
                                    const b64 = issueCoverImageBase64.replace(/^data:image\/\w+;base64,/, '');
                                    await fs.promises.writeFile(path.join(coversDir, `${finalIssueId}.jpg`), Buffer.from(b64, 'base64'));
                                    await prisma.issue.update({
                                        where: { id: finalIssueId },
                                        data: { coverUrl: `/api/uploads/issue-covers/${finalIssueId}.jpg?t=${Date.now()}`, hasCustomCover: true }
                                    });
                                    Logger.log(`[Match Series Debug] Wrote custom issue cover for ${finalIssueId}`, 'debug');
                                    // Issue #189 follow-up: bake the matcher's cover into the archive as
                                    // page 0 when asked (insert-only; shared core = same fixups/audit as
                                    // the series-page upload). Never aborts the match on failure — the
                                    // sidecar cover above is already saved for display.
                                    if (issueCoverEmbed === true) {
                                        const { embedUploadedCoverIntoArchive } = await import('@/lib/pages/insert-cover-core');
                                        const embedOutcome = await embedUploadedCoverIntoArchive(finalIssueId, (session?.user as any)?.id, 'matcher');
                                        if (!embedOutcome.ok) {
                                            Logger.log(`[Match Series] Cover saved but embedding into the archive failed for ${finalIssueId}: ${embedOutcome.error}`, 'warn');
                                        }
                                    }
                                } catch (coverErr) {
                                    Logger.log(`[Match Series] Failed to write issue cover for ${finalIssueId}: ${getErrorMessage(coverErr)}`, 'warn');
                                }
                            }

                        } catch (dbErr) {
                            Logger.log(`[Match Series Debug] CRITICAL DB ERROR for Issue ${issueNumStr}: ${dbErr}`, 'error');
                        }
                    }
                }
            }
        }

        if (hasNewCustomCover) {
            // Admin supplied a cover in the Smart Matcher editor — write it (already flagged custom above).
            try {
                const b64 = coverImageBase64.replace(/^data:image\/\w+;base64,/, '');
                await fs.promises.writeFile(path.join(activeFolderPath, 'cover.jpg'), Buffer.from(b64, 'base64'));
            } catch(e) {}
        } else if (imageUrl && !keepExistingCustomCover && !archiveKeepsLocalCover) {
            try {
                const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 3000, headers: { 'User-Agent': 'Omnibus/1.0' } });
                await fs.promises.writeFile(path.join(activeFolderPath, 'cover.jpg'), Buffer.from(imgRes.data));
            } catch(e) {}
        }
    } catch (err) {}

    try {
        const pendingRequests = await prisma.request.findMany({
            where: { volumeId: targetMetaId, status: { in: ['MANUAL_DDL', 'PENDING', 'DOWNLOADING'] } }
        });

        if (pendingRequests.length > 0) {
            const seriesIssues = await prisma.issue.findMany({ where: { series: { metadataId: targetMetaId } } });
            const requestsToComplete = [];

            for (const dbReq of pendingRequests) {
                const searchStr = (dbReq.activeDownloadName || (dbReq as any).title || (dbReq as any).name || "");
                // Added -? to capture negative requested issues
                const numMatch = searchStr.match(/(?:#|issue\s*#?)\s*(-?\d+(?:\.\d+)?)/i);
                const issueNum = numMatch ? parseFloat(numMatch[1]) : null;
                if (issueNum === null) continue;
                const matchingIssue = seriesIssues.find(i => parseFloat(i.number) === issueNum && i.filePath && i.filePath.length > 0);

                if (matchingIssue) requestsToComplete.push(dbReq.id);
            }

            if (requestsToComplete.length > 0) {
                await prisma.request.updateMany({
                    where: { id: { in: requestsToComplete } },
                    data: { status: 'COMPLETED', progress: 100 }
                });
            }
        }
    } catch (e) {}
    
    try {
        if (isFile) {
            // Include specificPath inside the payload
            await omnibusQueue.add('LIBRARY_SCAN', { 
                type: 'LIBRARY_SCAN', 
                specificPath: activeFolderPath 
            }, { 
                jobId: `LIBRARY_SCAN_${Date.now()}` 
            });
        }
        
        if (existingRecord?.id) {
            await omnibusQueue.add('METADATA_SYNC', { type: 'METADATA_SYNC', seriesIds: [existingRecord.id] }, { jobId: `METADATA_SYNC_MATCH_${existingRecord.id}_${Date.now()}` });

            // #199 round 4 Beta B (replace mode): the admin explicitly chose a provider rewrite —
            // regenerate this series' series.json NOW instead of waiting for the scheduled export
            // sweep (the job forwards a targeted series_ids list to the engine's Mylar-spec writer).
            if (dataMode === 'replace') {
                await omnibusQueue.add('EXPORT_SERIES_JSON',
                    { type: 'EXPORT_SERIES_JSON', seriesId: existingRecord.id },
                    { jobId: `EXPORT_SJ_REPLACE_${existingRecord.id}_${Date.now()}` }
                ).catch(e => Logger.log(`[Match Series] Couldn't queue the series.json regeneration: ${getErrorMessage(e)}`, 'warn'));
            }
        }

        // When the admin supplied custom metadata, embed it (SeriesGroup/Universe/Description) into the
        // files' ComicInfo.xml — unless they turned the per-edit toggle off, in which case fall back to
        // the global default. Mirrors library/update's EMBED-on-write resolution.
        if (lockMetadata && existingRecord?.id) {
            const doWrite = writeToFile !== undefined ? writeToFile : (config.metadata_write_comicinfo !== 'false');
            if (doWrite) {
                await omnibusQueue.add('EMBED_METADATA', { type: 'EMBED_METADATA', seriesId: existingRecord.id }, { jobId: `EMBED_META_MATCH_${existingRecord.id}_${Date.now()}` });
            }
        }
    } catch (e: any) {
        Logger.log(`[Match Series] Failed to queue jobs: ${e.message}`, 'warn');
    }

    if (conflicts > 0) {
        Logger.log(`[Match Series] Completed with ${conflicts} duplicate-file conflict(s) — left in place, not overwritten.`, 'warn');
    }

    const userId = (session?.user as any)?.id;
    if (userId) {
        await AuditLogger.log('MATCH_SERIES', { oldPath: oldFolderPath, newPath: activeFolderPath, conflicts }, userId);
    }

    revalidateTag('library'); revalidatePath('/library'); revalidatePath('/library/series');
    return NextResponse.json({ success: true, newPath: activeFolderPath, metadataId: targetMetaId, conflicts });

  } catch (error: unknown) {
    Logger.log(`[Match Series API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}