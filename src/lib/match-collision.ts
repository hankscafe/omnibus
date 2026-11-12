// src/lib/match-collision.ts
//
// Folder collisions at match time (field report by robotshavehearts2: "Image does it a lot"). A run
// and its collected editions are separate provider volumes that often share a NAME and a YEAR, so
// the folder pattern computes the same folder for both — and matching the second one used to
// repoint its series at the first one's folder and merge the files in. Two series never own one
// folder. This module answers who owns a folder, offers a free name, and carries out the
// resolution that is usually right: the trade goes UNDER the series it collects, as a COLLECTED
// attachment, its files moved into that series' folder under the collected naming pattern.
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';
import { moveFileSafe, cleanupEmptyDirs, ensureLibraryDir } from '@/lib/utils/safe-fs';
import { describeIssueFromFilename, normalizeFractionNumbers, isSameIssue } from '@/lib/utils/issue-parser';
import { COLLECTED_FILE_PATTERN, filePatternForIssue } from '@/lib/utils/file-pattern';
import { carriedStamp } from '@/lib/file-added';
import { issueFileName, issuePaddingFromSetting, issueTitleForName, type NamingInput } from '@/lib/utils/naming';
import { bookNumberFromFile, nameClaimsBook, yearFromFileName } from '@/lib/utils/collected-edition';

/** A folder as the disk sees it: one slash form, no trailing separator, no case. */
export const normalizeFolder = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function sameFolder(a: string, b: string): boolean {
    return normalizeFolder(a) === normalizeFolder(b);
}

export interface FolderOwner {
    id: string;
    name: string;
    year: number | null;
    publisher: string | null;
    imprint?: string | null;
    universe?: string | null;
    seriesGroup?: string | null;
    metadataSource: string;
    metadataId: string | null;
    folderPath: string;
    isManga: boolean;
}

/**
 * The series that owns `folderPath`, if any — never one of `excludeIds` (the rows a match is
 * allowed to repoint: the unmatched folder's own row, the row already matched to this volume).
 */
export async function folderOwner(folderPath: string, excludeIds: string[]): Promise<FolderOwner | null> {
    const base = path.basename(folderPath.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (!base) return null;
    const candidates = await prisma.series.findMany({
        where: { folderPath: { contains: base } },
        select: { id: true, name: true, year: true, publisher: true, imprint: true, universe: true, seriesGroup: true, metadataSource: true, metadataId: true, folderPath: true, isManga: true },
    });
    const hit = candidates.find(s => !!s.folderPath && sameFolder(s.folderPath, folderPath) && !excludeIds.includes(s.id));
    if (!hit) return null;
    return {
        id: hit.id, name: hit.name, year: hit.year ?? null, publisher: hit.publisher ?? null,
        metadataSource: hit.metadataSource || 'COMICVINE', metadataId: hit.metadataId ?? null, imprint: hit.imprint ?? null,
        universe: hit.universe ?? null, seriesGroup: hit.seriesGroup ?? null,
        folderPath: hit.folderPath, isManga: !!hit.isManga,
    };
}

/** The first "<name> (n)" beside `folderPath` that no series owns and no folder occupies. */
export async function suggestFreeFolderName(folderPath: string, excludeIds: string[]): Promise<string> {
    const clean = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parent = path.dirname(clean);
    const base = path.basename(clean);
    for (let n = 2; n < 100; n++) {
        const candidate = `${base} (${n})`;
        const candidatePath = `${parent}/${candidate}`;
        if (await folderOwner(candidatePath, excludeIds)) continue;
        if (fs.existsSync(candidatePath)) continue;
        return candidate;
    }
    return `${base} (${Date.now()})`;
}

/** One loose book of a multi-file attach (#257): its number and coverage as the admin confirmed them. */
export interface CollectedBookFile {
    path: string;
    /** Blank = parsed from the filename. */
    number?: string | null;
    /** Normalized coverage ("1-4"), or blank to leave it unset. */
    coversIssues?: string | null;
}

export interface AttachAsCollectedInput {
    owner: FolderOwner;
    /** The unmatched folder, or a single loose file. Ignored when `files` is given. */
    source: string;
    /** #257: several loose files at once, each with its confirmed number and coverage. */
    files?: CollectedBookFile[];
    /** The unmatched folder's own series row, if it has one (a loose file has none). */
    sourceSeriesId: string | null;
    metadataSource: string;
    volumeId: string;
    volumeName: string;
    volumeYear: number;
    config: Record<string, string>;
    libraryRoots: string[];
}

export interface AttachAsCollectedResult {
    attachmentId?: string;
    moved: number;
    absorbed: number;
    claimed: number;
    skeletonsReplaced: number;
    conflicts: number;
    /** #257 picked files only: books that hit an error and were left where they were. */
    failed?: number;
    error?: string;
}

const COMIC_EXT = /\.(cbz|cbr|cb7|zip|rar|pdf|epub)$/i;

/**
 * Attach the provider volume to `owner` as a COLLECTED edition, then bring the source's files under
 * it: each file moves into the owner's folder under the collected naming pattern, and its row —
 * the row that holds the file and any curation — becomes the provider book, taking the place of
 * the skeleton the engine's sync created for that number (the absorb rule from the attachments
 * route, extended to unmatched rows by NUMBER since they carry no provider id yet). A loose file
 * has no row: it claims the skeleton. A file whose collected name is already taken is left exactly
 * where it is, row and all, and counted. Nothing moves if the engine cannot import the volume.
 */
export async function attachAsCollected(input: AttachAsCollectedInput): Promise<AttachAsCollectedResult> {
    const { owner, source, files, sourceSeriesId, metadataSource, volumeId, volumeName, volumeYear, config, libraryRoots } = input;
    const fileList = files && files.length > 0 ? files : null;
    const result: AttachAsCollectedResult = { moved: 0, absorbed: 0, claimed: 0, skeletonsReplaced: 0, conflicts: 0 };
    // A LOCAL collected edition — one the provider has no volume for — has no lane to fetch, no
    // skeletons to replace, and keeps its files' own names: the name rule (beta.018) is the only
    // thing that can ever claim them back after a wipe, and a rename would erase that.
    const isLocal = metadataSource === 'LOCAL';

    // 1. The attachment (idempotent: re-running re-syncs).
    const attachment = await prisma.attachedVolume.upsert({
        where: { seriesId_metadataSource_volumeId: { seriesId: owner.id, metadataSource, volumeId } },
        update: { kind: 'COLLECTED', name: volumeName, startYear: volumeYear || null },
        create: { seriesId: owner.id, metadataSource, volumeId, kind: 'COLLECTED', name: volumeName, startYear: volumeYear || null },
    });
    result.attachmentId = attachment.id;

    // 2. The engine imports the volume's books as the lane's skeletons. Without that there is
    //    nothing to take the place of, so nothing is moved. (A local edition has none to import.)
    if (!isLocal) {
        try {
            const res = await engineFetchLong(ENGINE_URL + '/api/metadata/attach-sync', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ attachment_id: attachment.id, claim: true }),
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.ok) {
                result.error = payload?.error || `engine returned ${res.status}`;
                return result;
            }
        } catch (e) {
            Logger.log(`[Match Collision] Engine unreachable for the collected import: ${getErrorMessage(e)}`, 'error');
            result.error = 'The engine is unreachable.';
            return result;
        }
    }

    const lane = isLocal ? [] : await prisma.issue.findMany({
        where: { attachedVolumeId: attachment.id },
        select: { id: true, number: true, filePath: true, metadataId: true, metadataSource: true, name: true, coverUrl: true, releaseDate: true, description: true, coversIssues: true },
    });
    const usedTwins = new Set<string>();
    const twinFor = (number: string) => lane.find(l => !l.filePath && !usedTwins.has(l.id) && isSameIssue(l.number, number)) ?? null;

    // 3. What moves: the folder's comic files as the DISK lists them — a folder just dropped into
    //    /unmatched may have no rows yet — each paired with its row where the scan made one; or
    //    the one loose file; or (#257) the loose files the admin picked, with their confirmed numbers.
    const isFile = fileList ? true : (await fs.promises.stat(source)).isFile();
    const sourceRows = sourceSeriesId && !fileList
        ? await prisma.issue.findMany({ where: { seriesId: sourceSeriesId }, select: { id: true, number: true, filePath: true, isAnnual: true } })
        : [];
    const rowFor = (filePath: string) => sourceRows.find(r => !!r.filePath && sameFolder(r.filePath, filePath)) ?? null;
    type Item = { filePath: string; row: { id: string; number: string } | null; number?: string | null; coversIssues?: string | null };
    const items: Item[] = fileList
        ? fileList.map(f => ({ filePath: f.path, row: null, number: f.number, coversIssues: f.coversIssues }))
        : isFile
            ? [{ filePath: source, row: null }]
            : (await fs.promises.readdir(source))
                .filter(f => COMIC_EXT.test(f))
                .map(f => {
                    const filePath = `${source.replace(/\\/g, '/').replace(/\/+$/, '')}/${f}`;
                    const row = rowFor(filePath);
                    return { filePath: row?.filePath || filePath, row: row ? { id: row.id, number: row.number } : null };
                });

    const pattern = filePatternForIssue({
        isCollected: true,
        filePattern: config.file_naming_pattern || '{Series} #{Issue}',
        collectedFilePattern: config.collected_file_naming_pattern || null,
    });
    const ownerValues: NamingInput = {
        publisher: owner.publisher, series: owner.name, seriesYear: owner.year,
        universe: owner.universe, seriesGroup: owner.seriesGroup, imprint: owner.imprint,
    };
    const issuePadding = issuePaddingFromSetting(config.issue_number_padding);
    const ownerFolder = owner.folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    let ensured = false;

    for (const item of items) {
        const base = path.basename(item.filePath);
        const ext = path.extname(base).toLowerCase();
        let number = item.number?.trim()
            || item.row?.number
            // A picked book's own title is the hint (#257): the edition's name may have been changed
            // to tell it from the series ("… TPB"), and the filename doesn't carry that one.
            || (fileList ? bookNumberFromFile(base) : describeIssueFromFilename(base, volumeName).number)
            || '1';
        number = normalizeFractionNumbers(number);
        const twin = twinFor(number);
        let newName = base;
        if (!isLocal) {
            // Named like Standardize names it once the book is the owner's: the twin's release year,
            // else the owner's year; the twin's title.
            const stem = issueFileName(pattern, {
                ...ownerValues,
                issueNumber: number,
                releaseDate: twin?.releaseDate,
                issueTitle: issueTitleForName(twin?.name, owner.name, number),
            }, issuePadding);
            if (stem) newName = stem + ext;
        } else if (fileList && !nameClaimsBook(base, owner.name, volumeName, number)) {
            // A local book keeps its own name only while that name still claims it back after a wipe
            // (attachment-name.ts). "Power Rangers Prime v01" carries the SERIES' name, so it would
            // return as the run's #1: it takes the edition's name instead, the way Standardize names
            // a local book (seriesTokenForIssue). Picked files only; the extension never changes.
            // The admin's collected pattern is used when its result still claims the book back
            // ("{Publisher} - {Series} Vol. {Issue}" would not); else the default edition pattern.
            const named = (p: string) => {
                const stem = issueFileName(p, { ...ownerValues, series: volumeName, issueNumber: number, comicInfoYear: yearFromFileName(base) }, issuePadding);
                return stem ? stem + ext : null;
            };
            const configured = named(pattern);
            newName = configured && nameClaimsBook(configured, owner.name, volumeName, number)
                ? configured
                : (named(COLLECTED_FILE_PATTERN) ?? base);
        }
        const target = `${ownerFolder}/${newName}`;
        // A local book's identity is its lane and number — stable across a wipe, unlike a row id.
        const localIdentity = {
            metadataId: `local_${attachment.id}_${number}`, metadataSource: 'LOCAL', matchState: 'MATCHED', name: `Vol. ${number}`,
            ...(item.coversIssues ? { coversIssues: item.coversIssues } : {}),
        };

        // A different file already at the destination is never overwritten — this one stays put,
        // row, folder and all, and is counted so the caller can say so.
        if (fs.existsSync(target) && !sameFolder(target, item.filePath)) {
            Logger.log(`[Match Collision] "${newName}" already exists in ${ownerFolder}; left ${item.filePath} in place.`, 'warn');
            result.conflicts++;
            continue;
        }

        // #257: with picked files one book's failure (a move, a write) never strands the rest — it
        // goes back where it was and is counted. Other callers keep failing as a whole.
        let movedThis = false;
        try {
            if (!ensured) { await ensureLibraryDir(ownerFolder); ensured = true; }
            await moveFileSafe(item.filePath, target);
            movedThis = true;
            result.moved++;

            if (item.row) {
                if (twin) {
                    await prisma.issue.delete({ where: { id: twin.id } });
                    usedTwins.add(twin.id);
                    result.skeletonsReplaced++;
                }
                await prisma.issue.update({
                    where: { id: item.row.id },
                    data: {
                        seriesId: owner.id, attachedVolumeId: attachment.id, filePath: target, status: 'DOWNLOADED', isAnnual: false,
                        ...(isLocal ? localIdentity : {}),
                        ...(twin ? {
                            metadataId: twin.metadataId, metadataSource: twin.metadataSource, matchState: 'MATCHED',
                            ...(twin.name ? { name: twin.name } : {}),
                            ...(twin.coverUrl ? { coverUrl: twin.coverUrl } : {}),
                            ...(twin.releaseDate ? { releaseDate: twin.releaseDate } : {}),
                            ...(twin.description ? { description: twin.description } : {}),
                            // The sync prefilled the skeleton's coverage from the provider — it travels with the identity.
                            ...(twin.coversIssues ? { coversIssues: twin.coversIssues } : {}),
                        } : {}),
                    },
                });
                result.absorbed++;
            } else if (twin) {
                // #206 follow-up: a file with no row of its own has never been in the library — an
                // arrival. (A file that brings its row, above, keeps that row's time.)
                await prisma.issue.update({ where: { id: twin.id }, data: { filePath: target, status: 'DOWNLOADED', fileAddedAt: carriedStamp(null) } });
                usedTwins.add(twin.id);
                result.claimed++;
            } else {
                await prisma.issue.create({
                    data: {
                        seriesId: owner.id, attachedVolumeId: attachment.id, number, isAnnual: false, filePath: target, status: 'DOWNLOADED',
                        fileAddedAt: carriedStamp(null),
                        ...(isLocal
                            ? localIdentity
                            : { metadataId: `unmatched_${Math.random()}`, metadataSource: 'LOCAL', matchState: 'UNMATCHED', name: `Vol. ${number}` }),
                    },
                });
                result.claimed++;
            }
        } catch (e) {
            if (!fileList) throw e;
            Logger.log(`[Match Collision] Couldn't attach ${item.filePath}: ${getErrorMessage(e)}`, 'error');
            if (movedThis) {
                try { await moveFileSafe(target, item.filePath); result.moved--; } catch { /* left in the series folder; the next scan files it by name */ }
            }
            result.failed = (result.failed ?? 0) + 1;
        }
    }

    // 4. Only remove the source series once nothing is left pointing at it — never a blind delete.
    if (sourceSeriesId) {
        const remaining = await prisma.issue.count({ where: { seriesId: sourceSeriesId } });
        if (remaining === 0) {
            try { await prisma.series.delete({ where: { id: sourceSeriesId } }); } catch { /* already gone */ }
        }
    }
    const sourceDir = isFile ? path.dirname(source) : source;
    const root = libraryRoots.find(r => normalizeFolder(sourceDir).startsWith(normalizeFolder(r))) || path.dirname(sourceDir);
    if (!isFile) {
        try { await cleanupEmptyDirs(sourceDir, root); } catch (e) { Logger.log(`[Match Collision] Couldn't tidy ${sourceDir}: ${getErrorMessage(e)}`, 'debug'); }
    }

    return result;
}
