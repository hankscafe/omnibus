// src/lib/metadata-fetcher.ts
import { apiClient as axios } from '@/lib/api-client';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './logger';
import { parseComicVineCredits } from '@/lib/utils';
import { getErrorMessage } from './utils/error';
import { MetronProvider } from './metadata/providers/metron';
import { omnibusQueue } from './queue';
import { markSystemFlag, countApiUsage } from './utils/system-flags';
import { cachedCvGet } from './metadata/metadata-cache';
import { isSameIssue } from '@/lib/utils/issue-parser';
import { resolveSyncedName, detailNameWrite } from '@/lib/utils/synced-name';
import { findLocalCoverBasename, providerCoverBlocked } from '@/lib/utils/cover-plan';

// Providers rarely report when a series ends, so Omnibus guesses: no new issue
// within the admin-configured window (months) = Ended. Returns null when the
// guess is disabled (window of 0 / "Never").
async function getSeriesEndedCutoff(): Promise<{ cutoffMs: number, months: number } | null> {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'series_ended_months' } });
    const parsed = parseInt(setting?.value || '18', 10);
    const months = isNaN(parsed) ? 18 : parsed;
    if (months <= 0) return null;
    return { cutoffMs: Date.now() - Math.round(months * 30.44 * 24 * 60 * 60 * 1000), months };
}

export async function syncSeriesMetadata(metadataId: string, folderPath: string, metadataSource: string = 'COMICVINE') {
    const series = await prisma.series.findFirst({ 
        where: { metadataId, metadataSource } 
    });
    if (!series) throw new Error("Series not found in database.");

    // Update this line:
    Logger.log(`[Metadata] Fetching data for: "${series.name}" (ID: ${metadataId} via ${metadataSource})`, 'info');

    // cover_source policy, parity with the engine's resolve_cover (issue #194 follow-up): a custom
    // cover is never overwritten; in 'archive' mode an existing local/extracted cover file wins.
    // This Node fallback path used to download provider art unconditionally.
    const coverSource = (await prisma.systemSetting.findUnique({ where: { key: 'cover_source' } }))?.value || 'metadata';
    // file_metadata_priority: ComicInfo-derived values only get filled, never replaced. Read once —
    // the name resolver (both provider branches) and the Metron detail pass all honor it.
    const fillOnly = (await prisma.systemSetting.findUnique({ where: { key: 'file_metadata_priority' } }))?.value === 'true';

    if (metadataSource === 'METRON') {
        try {
            const metron = new MetronProvider();
            const details = await metron.getSeriesDetails(metadataId);
            
            if (!details) {
                Logger.log(`[Metadata] Details could not be fetched for ${series.name}. Skipping issue sync.`, 'warn');
                return { success: false, count: 0, skipped: true };
            }

            let metronFallbackCover = details.coverUrl || series.coverUrl;

            // --- FIX: Ensure folder exists so we can save the series cover locally ---
            if (folderPath && folderPath.trim() !== '' && !fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
            }
            const metronLocalCover = findLocalCoverBasename(folderPath);
            if (metronLocalCover) {
                metronFallbackCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, metronLocalCover))}`;
            }

            let metronFinalCover = metronFallbackCover;

            const metronCoverBlocked = providerCoverBlocked({
                hasCustomCover: !!series.hasCustomCover, coverSource, localCoverExists: !!metronLocalCover
            });

            if (!metronCoverBlocked && details.coverUrl && folderPath && fs.existsSync(folderPath)) {
                try {
                    const imgRes = await axios.get<ArrayBuffer>(details.coverUrl, { responseType: 'arraybuffer' });
                    const contentType = String(imgRes.headers['content-type'] || '').toLowerCase();
                    const byteLength = imgRes.data.byteLength;
                    
                    if (contentType.includes('text/html') || byteLength < 1000) {
                        throw new Error(`Invalid image payload. Type: ${contentType}, Size: ${byteLength} bytes.`);
                    }

                    let ext = '.jpg';
                    if (contentType.includes('image/png')) ext = '.png';
                    if (contentType.includes('image/webp')) ext = '.webp';

                    const coverFileName = `cover${ext}`;
                    await fs.writeFile(path.join(folderPath, coverFileName), Buffer.from(imgRes.data));
                    metronFinalCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, coverFileName))}`;
                    
                } catch (e: unknown) {
                    Logger.log(`[Metadata] Failed to save new cover, keeping existing fallback: ${getErrorMessage(e)}`, 'warn');
                }
            }
            
            await prisma.series.update({
                where: { id: series.id },
                data: {
                    name: details.name,
                    publisher: details.publisher,
                    year: details.year || series.year,
                    universe: details.universe,
                    description: details.description,
                    // A custom cover's stored URL is preserved verbatim — recomputing it here could
                    // repoint it, regardless of where the custom file lives.
                    coverUrl: series.hasCustomCover ? series.coverUrl : metronFinalCover,
                    // Keep the remote URL for external consumers (series.json) — coverUrl is a local path
                    ...(details.coverUrl ? { remoteCoverUrl: details.coverUrl } : {}),
                    // Metron's series_type is authoritative, but never clobber a manual categorization
                    ...(details.bookType && !series.bookType ? { bookType: details.bookType } : {}),
                    status: details.status
                }
            });

            const issues = await metron.getSeriesIssues(metadataId);
            let syncedCount = 0;
            
            const allSeriesIssues = await prisma.issue.findMany({
                where: { seriesId: series.id }
            });

            let latestDateMs = 0;
            // Number-anchored pairing (issue #194, engine resolve_pair_target parity — see the CV
            // branch below for the full contract).
            const claimedIds = new Set<string>();
            const insertedNums: string[] = [];

            for (const issue of issues) {
                const issueNumStr = issue.issueNumber;

                const issueDate = issue.releaseDate;
                if (issueDate) {
                    const ts = new Date(issueDate).getTime();
                    if (!isNaN(ts) && ts > latestDateMs) latestDateMs = ts;
                }

                const inSeriesById = allSeriesIssues.find(i =>
                    i.metadataId === issue.sourceId && isSameIssue(i.number, issueNumStr) && !claimedIds.has(i.id));
                const inSeriesByNum = inSeriesById || allSeriesIssues.find(i =>
                    isSameIssue(i.number, issueNumStr) && !claimedIds.has(i.id));
                let targetRecord = inSeriesByNum;
                let crossSeries = false;
                if (!targetRecord) {
                    if (allSeriesIssues.some(i => isSameIssue(i.number, issueNumStr)) ||
                        insertedNums.some(n => isSameIssue(n, issueNumStr))) {
                        Logger.log(`[Metadata] Duplicate provider number #${issueNumStr} (${issue.sourceId}) for "${series.name}" — first listing wins, skipping.`, 'info');
                        continue;
                    }
                    const global = await prisma.issue.findFirst({
                        where: { metadataId: issue.sourceId, metadataSource: 'METRON', seriesId: { not: series.id } }
                    });
                    if (global && isSameIssue(global.number, issueNumStr)) { targetRecord = global; crossSeries = true; }
                }
                const healId = !!targetRecord && targetRecord.metadataId !== issue.sourceId;
                const isLocked = (targetRecord as any)?.hasCustomMetadata || false;

                const issueDataPayload = {
                    // #199 round 3: Metron list names are composites ("X-Men (1991) #154") — the
                    // shared resolver lets them fill blanks but never clobber a real story title
                    // (detail-fetched or ComicInfo-read), and honors lock + file priority.
                    name: resolveSyncedName(targetRecord?.name, issue.name, issueNumStr, isLocked, fillOnly),
                    releaseDate: isLocked ? targetRecord!.releaseDate : issue.releaseDate,
                    description: issue.description,
                    coverUrl: issue.coverUrl,
                    // Metron's issue_list carries no per-issue credits — the old unconditional
                    // JSON.stringify wrote literal '[]' and wiped ComicInfo.xml-derived credits on
                    // every re-sync (issue #179; engine parity: columns left untouched when empty).
                    ...(issue.writers?.length ? { writers: JSON.stringify(issue.writers) } : {}),
                    ...(issue.artists?.length ? { artists: JSON.stringify(issue.artists) } : {}),
                    ...(issue.characters?.length ? { characters: JSON.stringify(issue.characters) } : {}),
                    // A healed row drops DEEP_SYNCED (its deep data belonged to the old id); otherwise
                    // enrichment-completed issues keep DEEP_SYNCED (engine parity: next_match_state).
                    matchState: !healId && targetRecord?.matchState === 'DEEP_SYNCED' ? 'DEEP_SYNCED' : 'MATCHED'
                };
                if (healId && !isLocked) {
                    Logger.log(`[Metadata] Healing issue #${issueNumStr} of "${series.name}" — stored id disagreed with its number, re-linking to ${issue.sourceId} (issue #194).`, 'info');
                    Object.assign(issueDataPayload, {
                        writers: null, artists: null, coverArtists: null, colorists: null,
                        letterers: null, characters: null, teams: null, locations: null, storyArcs: null
                    });
                }

                if (targetRecord) {
                    await prisma.issue.update({
                        where: { id: targetRecord.id },
                        data: { seriesId: series.id, metadataId: issue.sourceId, metadataSource: 'METRON', ...issueDataPayload }
                    });
                    claimedIds.add(targetRecord.id);
                    if (crossSeries) Logger.log(`[Metadata] Adopted issue #${issueNumStr} (${issue.sourceId}) into "${series.name}" from another series (id+number agree).`, 'info');
                } else {
                    await prisma.issue.create({
                        data: {
                            seriesId: series.id,
                            metadataId: issue.sourceId,
                            metadataSource: 'METRON',
                            number: issueNumStr,
                            status: 'WANTED',
                            ...issueDataPayload
                        }
                    });
                    insertedNums.push(issueNumStr);
                }
                syncedCount++;
            }

            if (details.status !== 'Ended' && latestDateMs > 0) {
                const endedWindow = await getSeriesEndedCutoff();
                if (endedWindow && latestDateMs < endedWindow.cutoffMs) {
                    await prisma.series.update({
                        where: { id: series.id },
                        data: { status: 'Ended' }
                    });
                    Logger.log(`[Metadata] Series "${series.name}" marked as Ended after ${endedWindow.months}+ months without a new issue.`, 'info');
                }
            }

            // Per-issue title + credit enrichment: the issue_list carries no credits and no story
            // titles, so each not-yet-deep-synced issue costs one /issue/{id}/ detail call. Budgeted
            // against Metron's 5,000/day window with a reserve — leftovers stay non-DEEP_SYNCED and
            // resume on the next sync. Engine parity: metadata.rs metron_detail_credit_pass. Runs
            // before the EMBED_METADATA queue below so the fetched values reach the archives too.
            // #199 round 3: no metron_detail_credits gate here — every Node caller is a targeted
            // match-time sync (match/request/import; the scheduled sweep is engine-only), and the
            // matcher's contract is that a corrected issue ID brings the issue's real title and
            // credits on its own. The opt-in still governs the engine's scheduled sweep.
            {
                // Locked (hasCustomMetadata) issues are excluded outright: the merge policy would
                // keep every existing column anyway, so the detail call would be a pure quota burn.
                const candidates = await prisma.issue.findMany({
                    where: {
                        seriesId: series.id,
                        metadataSource: 'METRON',
                        metadataId: { not: null },
                        matchState: { not: 'DEEP_SYNCED' },
                        hasCustomMetadata: false
                    }
                });
                // Never-wipe merge (issue #179): undefined = leave the column untouched. An empty
                // provider list never overwrites; file_metadata_priority only fills blanks.
                const mergeCredits = (existing: string | null, fetched: string[] | undefined): string | undefined => {
                    if (!fetched || fetched.length === 0) return undefined;
                    const existingHasData = !!existing && existing.trim() !== '' && existing.trim() !== '[]';
                    return (fillOnly && existingHasData) ? undefined : JSON.stringify(fetched);
                };
                let enriched = 0;
                for (const candidate of candidates) {
                    const used = await countApiUsage('metron');
                    if (used + 500 >= 5000) {
                        Logger.log(`[Metadata] Metron daily budget reached (${used} calls) — deferring credit enrichment for ${candidates.length - enriched} issue(s) of "${series.name}" to the next sync.`, 'info');
                        break;
                    }
                    try {
                        const detail = await metron.getIssueDetails(candidate.metadataId!);
                        await prisma.issue.update({
                            where: { id: candidate.id },
                            data: {
                                // The issue's own story title finally lands (#199 round 3):
                                // undefined leaves the column untouched, same as the credits below.
                                name: detailNameWrite(candidate.name, detail.storyTitle, candidate.number, fillOnly) ?? undefined,
                                writers: mergeCredits(candidate.writers, detail.writers),
                                artists: mergeCredits(candidate.artists, detail.artists),
                                coverArtists: mergeCredits(candidate.coverArtists, detail.coverArtists),
                                colorists: mergeCredits(candidate.colorists, detail.colorists),
                                letterers: mergeCredits(candidate.letterers, detail.letterers),
                                inker: mergeCredits((candidate as any).inker, detail.inker),
                                editor: mergeCredits((candidate as any).editor, detail.editor),
                                translator: mergeCredits((candidate as any).translator, detail.translator),
                                characters: mergeCredits(candidate.characters, detail.characters),
                                teams: mergeCredits(candidate.teams, detail.teams),
                                storyArcs: mergeCredits(candidate.storyArcs, detail.storyArcs),
                                matchState: 'DEEP_SYNCED'
                            }
                        });
                        enriched++;
                    } catch (e: any) {
                        if (e.response?.status === 404) {
                            // Gone from Metron — promote anyway so we never re-pay for the lookup.
                            await prisma.issue.update({ where: { id: candidate.id }, data: { matchState: 'DEEP_SYNCED' } }).catch(() => {});
                            continue;
                        }
                        if (e.message?.includes('FATAL_RATE_LIMIT') || e.response?.status === 429) await markSystemFlag('metron_rate_limit_time');
                        // The series sync itself already succeeded — stop enriching, retry next sync.
                        Logger.log(`[Metadata] Metron credit enrichment stopped early for "${series.name}": ${getErrorMessage(e)} — remaining issues retry next sync.`, 'warn');
                        break;
                    }
                }
                if (enriched > 0) Logger.log(`[Metadata] Enriched ${enriched} Metron issue(s) of "${series.name}" with detail-call credits.`, 'info');
            }

            try {
                // 15-minute rolling window for heavy disk I/O
                const ioTimeWindow = Math.floor(Date.now() / 900000); 
                
                await omnibusQueue.add('EMBED_METADATA', { 
                    type: 'EMBED_METADATA', 
                    seriesId: series.id 
                }, {
                    jobId: `EMBED_META_${series.id}_${ioTimeWindow}`,
                    delay: 300000, // 5-minute delay to let the entire batch finish downloading
                    removeOnComplete: true,
                    removeOnFail: true
                });
                Logger.log(`[Metadata] Queued XML injection for ${series.name}`, 'info');
            } catch(e) {}

            Logger.log(`[Metadata] Successfully synced ${syncedCount} Metron issues.`, 'success');
            return { success: true, count: syncedCount };

        } catch (e: any) {
            if (e.response?.status === 429) await markSystemFlag('metron_rate_limit_time');
            throw e;
        }
    }

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!setting?.value) throw new Error("No ComicVine API Key configured.");

    Logger.log(`[Metadata Fetcher Debug] Requesting ComicVine Volume: https://comicvine.gamespot.com/api/volume/4050-${metadataId}/`, 'debug');
    
    let volRes;
    try {
        // Cache-aware (metadata_cache_enabled): usage logging happens inside cachedCvGet for real
        // upstream calls only.
        volRes = await cachedCvGet(`https://comicvine.gamespot.com/api/volume/4050-${metadataId}/`, {
            params: { api_key: setting.value, format: 'json', field_list: 'image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year,count_of_issues' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000
        });
    } catch (e: any) {
        if (e.response?.status === 429) await markSystemFlag('cv_rate_limit_time');
        throw e;
    }

    const volData = volRes.data.results;
    if (!volData) throw new Error("Volume data not found on ComicVine.");

    const imageUrl = volData.image?.medium_url || volData.image?.super_url;

    const { genres: volGenres } = parseComicVineCredits(undefined, undefined, volData.concepts || undefined);
    
    let cvFallbackCover = imageUrl || series.coverUrl;

    // --- FIX: Ensure folder exists so we can save the series cover locally ---
    if (folderPath && folderPath.trim() !== '' && !fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }
    const cvLocalCover = findLocalCoverBasename(folderPath);
    if (cvLocalCover) {
        cvFallbackCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, cvLocalCover))}`;
    }

    let cvFinalCover = cvFallbackCover;

    const cvCoverBlocked = providerCoverBlocked({
        hasCustomCover: !!series.hasCustomCover, coverSource, localCoverExists: !!cvLocalCover
    });

    if (!cvCoverBlocked && imageUrl && folderPath && fs.existsSync(folderPath)) {
        try {
            const imgRes = await axios.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer' });
            const contentType = String(imgRes.headers['content-type'] || '').toLowerCase();
            const byteLength = imgRes.data.byteLength;
            
            if (contentType.includes('text/html') || byteLength < 1000) {
                throw new Error(`Invalid image payload. Type: ${contentType}, Size: ${byteLength} bytes.`);
            }

            let ext = '.jpg';
            if (contentType.includes('image/png')) ext = '.png';
            if (contentType.includes('image/webp')) ext = '.webp';

            const coverFileName = `cover${ext}`;
            await fs.writeFile(path.join(folderPath, coverFileName), Buffer.from(imgRes.data));
            cvFinalCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, coverFileName))}`;
            
        } catch (e: unknown) {
            Logger.log(`[Metadata] Failed to save new cover, keeping existing fallback: ${getErrorMessage(e)}`, 'warn');
        }
    }

    // ComicVine has no format field, so book type is a conservative guess: explicit
    // format hints in the volume name, or a finished single-issue volume = one-shot
    let guessedBookType: string | null = null;
    const volName = volData.name || '';
    if (/graphic novel|\bOGN\b/i.test(volName)) guessedBookType = 'GN';
    else if (/\bTPB\b|trade paperback|\bHC\b|hardcover/i.test(volName)) guessedBookType = 'TPB';
    else if (volData.count_of_issues === 1 && volData.end_year) guessedBookType = 'OneShot';

    await prisma.series.update({
        where: { id: series.id },
        data: {
            name: volData.name,
            publisher: volData.publisher?.name || 'Other',
            year: parseInt(volData.start_year || "0") || series.year,
            description: volData.description || volData.deck || null,
            // A custom cover's stored URL is preserved verbatim — recomputing it here could
            // repoint it, regardless of where the custom file lives.
            coverUrl: series.hasCustomCover ? series.coverUrl : cvFinalCover,
            // Keep the remote URL for external consumers (series.json) — coverUrl is a local path
            ...(imageUrl ? { remoteCoverUrl: imageUrl } : {}),
            // Heuristic only fills a blank — never clobber a manual categorization
            ...(guessedBookType && !series.bookType ? { bookType: guessedBookType } : {}),
            status: volData.end_year ? 'Ended' : 'Ongoing'
        }
    });

    await new Promise(r => setTimeout(r, 3000));

    let offset = 0;
    let totalResults = 1;
    let loopCount = 0;
    let syncedCount = 0;
    let issuesCallsMade = 0;

    Logger.log(`[Metadata Fetcher Debug] Fetching issues for volume "${series.name}" (ID: ${metadataId}, Offset: ${offset}, Limit: 100)`, 'debug');
    let latestDateMs = 0;
    // Claim set + same-batch insert-number guard (issue #194): one write per row per sync, and a
    // duplicate provider number can't insert a second row or overwrite an earlier pairing.
    const claimedIds = new Set<string>();
    const insertedNums: string[] = [];
    while (offset < totalResults && loopCount < 20) {
        Logger.log(`[Metadata Fetcher Debug] Fetching issues for volume "${series.name}" (ID: ${metadataId}, Offset: ${offset}, Limit: 100)`, 'debug');
        let issueRes;
        try {
            // Cache-aware: each page is its own cache entry (offset is in the key); real calls are
            // usage-logged inside cachedCvGet, so the old aggregate issuesCallsMade logging is gone.
            issueRes = await cachedCvGet(`https://comicvine.gamespot.com/api/issues/`, {
                params: {
                    api_key: setting.value, format: 'json', filter: `volume:${metadataId}`, sort: 'issue_number:asc', limit: 100, offset: offset,
                    field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description'
                },
                headers: { 'User-Agent': 'Omnibus/1.0' },
                timeout: 15000
            });
            issuesCallsMade++;
        } catch (e: any) {
            if (e.response?.status === 429) await markSystemFlag('cv_rate_limit_time');
            throw e;
        }

        const data = issueRes.data;
        if (offset === 0) totalResults = data.number_of_total_results || 0;
        
        const cvIssues = data.results || [];

        const allSeriesIssuesForCv = await prisma.issue.findMany({
            where: { seriesId: series.id }
        });

        for (const cvIssue of cvIssues) {
            const issueNumStr = cvIssue.issue_number?.toString() || "0";
            const cvIdStr = cvIssue.id.toString();

            const issueDate = cvIssue.store_date || cvIssue.cover_date || null;
            if (issueDate) {
                const ts = new Date(issueDate).getTime();
                if (!isNaN(ts) && ts > latestDateMs) latestDateMs = ts;
            }

            // Number-anchored pairing (issue #194, parity with the engine's resolve_pair_target):
            // within the series the row's number is the identity anchor; a stored id is honored only
            // when the number agrees, otherwise the number wins and the id is HEALED. The claimed
            // set gives one write per row per sync, and number is never rewritten by an id match.
            const inSeriesById = allSeriesIssuesForCv.find(i =>
                i.metadataId === cvIdStr && isSameIssue(i.number, issueNumStr) && !claimedIds.has(i.id));
            const inSeriesByNum = inSeriesById || allSeriesIssuesForCv.find(i =>
                isSameIssue(i.number, issueNumStr) && !claimedIds.has(i.id));
            let targetRecord = inSeriesByNum;
            let crossSeries = false;
            if (!targetRecord) {
                if (allSeriesIssuesForCv.some(i => isSameIssue(i.number, issueNumStr)) ||
                    insertedNums.some(n => isSameIssue(n, issueNumStr))) {
                    Logger.log(`[Metadata] Duplicate provider number #${issueNumStr} (${cvIdStr}) for "${series.name}" — first listing wins, skipping.`, 'info');
                    continue;
                }
                // Cross-series adoption only when id AND number agree (a mispaired global id match
                // is never a steal target).
                const global = await prisma.issue.findFirst({
                    where: { metadataId: cvIdStr, metadataSource: 'COMICVINE', seriesId: { not: series.id } }
                });
                if (global && isSameIssue(global.number, issueNumStr)) { targetRecord = global; crossSeries = true; }
            }
            const healId = !!targetRecord && targetRecord.metadataId !== cvIdStr;
            const isLocked = (targetRecord as any)?.hasCustomMetadata || false;

            const issueDataPayload = {
                // Shared resolver (#199 round 3): keeps lock + file-priority semantics and stops a
                // null/generic provider name from wiping a real story title (engine parity).
                name: resolveSyncedName(targetRecord?.name, cvIssue.name, issueNumStr, isLocked, fillOnly),
                releaseDate: isLocked ? targetRecord!.releaseDate : (cvIssue.store_date || cvIssue.cover_date || null),
                description: cvIssue.description || cvIssue.deck || null,
                coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
                matchState: 'MATCHED'
            };

            const dynamicPayload: any = { ...issueDataPayload };
            if (volGenres.length > 0 && (!targetRecord || !(targetRecord as any).genres || healId)) {
                dynamicPayload.genres = JSON.stringify(volGenres);
            }
            // A healed row's enrichment-era fields belonged to the WRONG issue — reset the credit
            // columns (the guarded view-time enrichment refills them for the correct id) and drop
            // DEEP_SYNCED via the MATCHED matchState above. A locked row keeps curated content.
            if (healId && !isLocked) {
                Logger.log(`[Metadata] Healing issue #${issueNumStr} of "${series.name}" — stored id disagreed with its number, re-linking to ${cvIdStr} (issue #194).`, 'info');
                Object.assign(dynamicPayload, {
                    writers: null, artists: null, coverArtists: null, colorists: null,
                    letterers: null, characters: null, teams: null, locations: null, storyArcs: null
                });
            }

            if (targetRecord) {
                await prisma.issue.update({
                    where: { id: targetRecord.id },
                    data: {
                        seriesId: series.id,
                        metadataId: cvIdStr,
                        metadataSource: 'COMICVINE',
                        ...dynamicPayload
                    }
                });
                claimedIds.add(targetRecord.id);
                if (crossSeries) Logger.log(`[Metadata] Adopted issue #${issueNumStr} (${cvIdStr}) into "${series.name}" from another series (id+number agree).`, 'info');
            } else {
                await prisma.issue.create({
                    data: {
                        seriesId: series.id,
                        metadataId: cvIdStr,
                        metadataSource: 'COMICVINE',
                        number: issueNumStr,
                        status: 'WANTED',
                        ...dynamicPayload
                    }
                });
                insertedNums.push(issueNumStr);
            }
            syncedCount++;
        }

        offset += 100;
        loopCount++;

        await new Promise(r => setTimeout(r, 3000));
    }
    // The loopCount<20 guard caps a sync at 2000 issues; warn (instead of silently clipping) when a volume
    // genuinely has more — latestDateMs and the 'Ended' heuristic would also be incomplete in that case.
    if (loopCount >= 20 && offset < totalResults) {
        Logger.log(`[Metadata Fetcher] "${series.name}" exceeded the 2000-issue sync cap (${offset}/${totalResults}); remaining issues were not synced this run.`, 'warn');
    }

    if (!volData.end_year && latestDateMs > 0) {
        const endedWindow = await getSeriesEndedCutoff();
        if (endedWindow && latestDateMs < endedWindow.cutoffMs) {
            await prisma.series.update({
                where: { id: series.id },
                data: { status: 'Ended' }
            });
            Logger.log(`[Metadata] Series "${series.name}" marked as Ended after ${endedWindow.months}+ months without a new issue.`, 'info');
        }
    }

    try {
                // 15-minute rolling window for heavy disk I/O
                const ioTimeWindow = Math.floor(Date.now() / 900000); 
                
                await omnibusQueue.add('EMBED_METADATA', { 
                    type: 'EMBED_METADATA', 
                    seriesId: series.id 
                }, {
                    jobId: `EMBED_META_${series.id}_${ioTimeWindow}`,
                    delay: 300000, // 5-minute delay to let the entire batch finish downloading
                    removeOnComplete: true,
                    removeOnFail: true
                });
                Logger.log(`[Metadata] Queued XML injection for ${series.name}`, 'info');
            } catch(e) {}

    Logger.log(`[Metadata] Successfully synced ${syncedCount} ComicVine issues.`, 'success');
    return { success: true, count: syncedCount };
}