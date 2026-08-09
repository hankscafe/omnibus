// src/lib/utils/match-prefill.ts
//
// #199 round 4 (Beta A): the Smart Matcher reads the library's OWN metadata before asking a
// provider. Loose files contribute their ComicInfo.xml (never scanned before — the awaiting-match
// dir is a live listing); folders contribute their scan-banked Series row plus a FRESH series.json
// read (catching sidecars edited after the last scan, the same gap 5F closes at scan time).
// File data is PRIMARY: the merge tags every value with its source so the dialog can badge what
// came from the user's curation vs what a provider filled. Ids ride along for the id-assist.
//
// Engine twins: parse_series_json / notes_issue_ids in omnibus-engine/src/scanner.rs — change one
// side only with a mirrored change + test on the other.
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '@/lib/logger';
import { COLUMN_TO_LIST_FIELD } from '@/lib/utils/comicinfo-fields';

/** Mylar-spec series.json, the fields Omnibus reads (engine SeriesJsonInfo twin). */
export interface SeriesJsonInfo {
    comicid: number | null;
    name: string | null;
    publisher: string | null;
    year: number | null;
    description: string | null;
    booktype: string | null;
    status: string | null;
}

export function parseSeriesJson(content: string): SeriesJsonInfo | null {
    let v: any;
    try { v = JSON.parse(content); } catch { return null; }
    const m = v?.metadata;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const getStr = (k: string): string | null => {
        const s = typeof m[k] === 'string' ? m[k].trim() : '';
        return s ? s : null;
    };
    const num = (x: any): number | null => {
        const n = typeof x === 'number' ? x : (typeof x === 'string' ? parseInt(x.trim(), 10) : NaN);
        return Number.isFinite(n) ? n : null;
    };
    const comicid = (() => { const n = num(m.comicid); return n && n > 0 ? n : null; })();
    const year = (() => { const n = num(m.year); return n && n !== 0 ? n : null; })();
    const rawStatus = getStr('status');
    return {
        comicid,
        name: getStr('name'),
        publisher: getStr('publisher'),
        year,
        description: getStr('description_text'),
        booktype: getStr('booktype'),
        status: rawStatus ? (rawStatus.toLowerCase() === 'ended' ? 'Ended' : 'Ongoing') : null,
    };
}

/** Reads `<folder>/series.json` if present; read/parse failures are null (evidence, not errors). */
export async function readSeriesJson(folder: string): Promise<SeriesJsonInfo | null> {
    try {
        const content = await fs.promises.readFile(path.join(folder, 'series.json'), 'utf8');
        const parsed = parseSeriesJson(content);
        if (!parsed) Logger.log(`[Match Prefill] ${folder}\\series.json exists but is not a parseable Mylar-spec series.json — ignoring it.`, 'warn');
        return parsed;
    } catch {
        return null;
    }
}

/** Issue ids from a ComicTagger/Mylar <Notes> tag: "[CVDB987]" short form first, else
 *  "[Issue ID 123456]" (Comic Vine unless Metron is named in the surrounding text). Older tagged
 *  files carry ONLY Notes — no Web, no dedicated id tags. Engine twin: notes_issue_ids. */
export function notesIssueIds(notes: string | null | undefined): { cvIssueId: number | null; metronIssueId: number | null } {
    const n = notes || '';
    const cvdb = n.match(/CVDB(\d+)/i);
    if (cvdb) return { cvIssueId: parseInt(cvdb[1], 10), metronIssueId: null };
    const generic = n.match(/issue\s*id\s*:?\s*#?(\d+)/i);
    if (generic) {
        const id = parseInt(generic[1], 10);
        return n.toLowerCase().includes('metron')
            ? { cvIssueId: null, metronIssueId: id }
            : { cvIssueId: id, metronIssueId: null };
    }
    return { cvIssueId: null, metronIssueId: null };
}

/** Where a prefilled value came from — the dialog badges these. */
export type PrefillSource = 'comicinfo' | 'series.json' | 'scan';

export interface PrefillField { value: string; source: PrefillSource }

export interface MatchPrefill {
    /** Core series fields + the ComicInfo default keys, each tagged with its file-side source. */
    fields: Record<string, PrefillField>;
    /** blackAndWhite kept separate (boolean tri-state semantics, like the dialog). */
    blackAndWhite?: { value: boolean; source: PrefillSource };
    /** Provider ids found in the files — the id-assist consumes these. */
    ids: {
        cvVolumeId: number | null;
        cvIssueId: number | null;
        metronSeriesId: number | null;
        metronIssueId: number | null;
    };
    /** Loose files only: the tagger's own number/title for the single issue. */
    issue?: { number: string | null; title: string | null };
}

const put = (
    fields: Record<string, PrefillField>,
    key: string,
    value: string | number | null | undefined,
    source: PrefillSource,
    overwrite = false,
) => {
    const s = value == null ? '' : String(value).trim();
    if (!s) return;
    if (!overwrite && fields[key]) return;
    fields[key] = { value: s, source };
};

const joinList = (arr: unknown): string => Array.isArray(arr) ? arr.filter(Boolean).join(', ') : '';

/** parseComicInfo() output → dialog-shaped prefill fields (loose files). */
export function comicInfoPrefill(ci: any): MatchPrefill {
    const fields: Record<string, PrefillField> = {};
    put(fields, 'name', ci.series, 'comicinfo');
    put(fields, 'year', ci.year, 'comicinfo');
    put(fields, 'publisher', ci.publisher, 'comicinfo');
    put(fields, 'description', ci.summary, 'comicinfo');
    put(fields, 'universe', ci.universe, 'comicinfo');
    put(fields, 'seriesGroup', ci.seriesGroup, 'comicinfo');
    // List-type defaults from the parsed arrays (dialog keys, comma-joined).
    put(fields, 'writer', joinList(ci.writers), 'comicinfo');
    put(fields, 'penciller', joinList(ci.artists), 'comicinfo');
    put(fields, 'inker', joinList(ci.inker), 'comicinfo');
    put(fields, 'colorist', joinList(ci.colorists), 'comicinfo');
    put(fields, 'letterer', joinList(ci.letterers), 'comicinfo');
    put(fields, 'coverArtist', joinList(ci.coverArtists), 'comicinfo');
    put(fields, 'editor', joinList(ci.editor), 'comicinfo');
    put(fields, 'translator', joinList(ci.translator), 'comicinfo');
    put(fields, 'tags', joinList(ci.tags), 'comicinfo');
    put(fields, 'characters', joinList(ci.characters), 'comicinfo');
    put(fields, 'teams', joinList(ci.teams), 'comicinfo');
    put(fields, 'locations', joinList(ci.locations), 'comicinfo');
    // Scalars sharing the ComicInfo tag name.
    put(fields, 'mainCharacterOrTeam', ci.mainCharacterOrTeam, 'comicinfo');
    put(fields, 'alternateSeries', ci.alternateSeries, 'comicinfo');
    put(fields, 'alternateNumber', ci.alternateNumber, 'comicinfo');
    put(fields, 'alternateCount', ci.alternateCount, 'comicinfo');
    put(fields, 'storyArcNumber', ci.storyArcNumber, 'comicinfo');
    put(fields, 'gtin', ci.gtin, 'comicinfo');
    put(fields, 'scanInformation', ci.scanInformation, 'comicinfo');
    put(fields, 'review', ci.review, 'comicinfo');
    put(fields, 'communityRating', ci.communityRating, 'comicinfo');
    // Notes deliberately NOT prefolded into the series-default Notes field: per-file Notes carry
    // tagger fingerprints (provenance the embed writer preserves per-issue), not series metadata.
    const notesIds = notesIssueIds(ci.notes);
    const bw = ci.blackAndWhite === true ? { value: true as const, source: 'comicinfo' as const } : undefined;
    return {
        fields,
        ...(bw ? { blackAndWhite: bw } : {}),
        ids: {
            cvVolumeId: ci.cvId ?? null,
            cvIssueId: ci.cvIssueId ?? notesIds.cvIssueId,
            metronSeriesId: ci.metronId ?? null,
            metronIssueId: ci.metadataSource === 'METRON' ? (ci.metadataIssueId ?? notesIds.metronIssueId) : notesIds.metronIssueId,
        },
        issue: { number: ci.number ?? null, title: ci.title ?? null },
    };
}

/** Scan-banked Series row + fresh series.json → prefill fields (folders). The row is already
 *  file-first truth (unmatched series have never met a provider), so it seeds at 'scan'
 *  provenance and the FRESH series.json overrides its own seven fields on top. */
export function folderPrefill(row: any | null, sj: SeriesJsonInfo | null): MatchPrefill {
    const fields: Record<string, PrefillField> = {};
    if (row) {
        put(fields, 'name', row.name, 'scan');
        put(fields, 'year', row.year, 'scan');
        put(fields, 'publisher', row.publisher === 'Unknown' ? '' : row.publisher, 'scan');
        put(fields, 'description', row.description, 'scan');
        put(fields, 'universe', row.universe, 'scan');
        put(fields, 'seriesGroup', row.seriesGroup, 'scan');
        // ComicInfo default columns banked by scan 5H (+ genres, which predates them).
        for (const [column, field] of Object.entries(COLUMN_TO_LIST_FIELD)) {
            const raw = row[column];
            if (typeof raw !== 'string' || !raw.trim() || raw.trim() === '[]') continue;
            try {
                const arr = JSON.parse(raw);
                put(fields, field, joinList(arr), 'scan');
            } catch { /* non-JSON legacy value — skip rather than mislead */ }
        }
        for (const scalar of ['imprint', 'format', 'languageISO', 'ageRating', 'gtin', 'scanInformation', 'review', 'mainCharacterOrTeam', 'storyArcNumber', 'alternateSeries', 'alternateNumber'] as const) {
            put(fields, scalar, row[scalar], 'scan');
        }
        put(fields, 'alternateCount', row.alternateCount, 'scan');
        put(fields, 'communityRating', row.communityRating, 'scan');
    }
    if (sj) {
        put(fields, 'name', sj.name, 'series.json', true);
        put(fields, 'year', sj.year, 'series.json', true);
        put(fields, 'publisher', sj.publisher, 'series.json', true);
        put(fields, 'description', sj.description, 'series.json', true);
    }
    const bw = row?.blackAndWhite === true ? { value: true as const, source: 'scan' as const } : undefined;
    return {
        fields,
        ...(bw ? { blackAndWhite: bw } : {}),
        ids: {
            cvVolumeId: sj?.comicid ?? null,
            cvIssueId: null,
            metronSeriesId: null,
            metronIssueId: null,
        },
    };
}

/** True when the prefill carries anything worth showing — the page skips empty payloads. */
export function prefillHasContent(p: MatchPrefill | null | undefined): boolean {
    if (!p) return false;
    return Object.keys(p.fields).length > 0 || !!p.blackAndWhite || !!p.issue?.title || !!p.issue?.number
        || !!(p.ids.cvVolumeId || p.ids.cvIssueId || p.ids.metronSeriesId || p.ids.metronIssueId);
}

// The dialog-side seeding rule (seedValue) lives in smart-match-metadata-dialog.tsx — this module
// is server-only (fs import) and the dialog is a client component; type-only imports cross fine.
