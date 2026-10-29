// src/lib/request-fulfilment.ts
//
// v1.4.10-beta.009: a request closes once its issue is in the library, however the file got there.
//
// Before this, an import closed its own request (the importer, the watched-folder handoff) and the
// Smart Matcher closed four statuses. A request parked as Not Found Yet, Awaiting Date, Stalled or
// Unreleased whose issue then arrived another way - matched in by hand, dropped into the library and
// scanned - stayed open, and the monitor's parked sweep went on searching for it every
// awaiting_retry_days, downloading the issue a second time once a source had it.
//
// Two doors, one rule:
//   - the Smart Matcher, for the series it just matched (closeRequestsFulfilledBySeries);
//   - the Series Monitor, on every run, for every parked request (closeFulfilledParkedRequests),
//     before its unreleased upgrade and parked sweep read a single request.
//
// "In the library" is the monitor's own question (monitor.rs in_library_or_covered): a run issue with
// a file, or one reprinted in a collected edition you own; an annual only by an annual; a request made
// for an attached volume by that volume's own issue; a Special's request (#255: filed against the
// parent's volume under the Special's own name) only by that Special's own issue. A request is tied to a series by its provider id -
// never by the bare number, which a Metron series and a ComicVine volume can share - by the other
// provider's id the series stores (Series.cvId / metronId), or by the local id older rows carry. A
// request with no series id (volumeId "0": a MyAnimeList or AniList import) can't be tied to anything.
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { SystemNotifier } from '@/lib/notifications';
import { getErrorMessage } from '@/lib/utils/error';
import { isSameIssue } from '@/lib/utils/issue-parser';
import { attachmentForFilename } from '@/lib/utils/attachment-name';
import { ownedCoverageBySeries } from '@/lib/coverage-ownership';
import { issueNumberOf } from '@/lib/request-dedupe';
import { COMPLETABLE_STATUSES, WAITING_STATUSES } from '@/lib/request-status';

/** A match closes a request in any state that is still waiting for its issue: all but IMPORTING, whose
 *  pack the watched-folder handoff is settling (import-handoff.ts). */
export const CLOSE_ON_MATCH_STATUSES: readonly string[] = [
    'PENDING_APPROVAL', 'PENDING', 'DOWNLOADING', 'MANUAL_DDL', 'NEEDS_REVIEW', 'STALLED', 'UNRELEASED', ...WAITING_STATUSES,
];

/** The monitor also leaves the two whose own work is under way, a queued search (PENDING) and a
 *  running download (DOWNLOADING): the importer settles those. */
export const CLOSE_ON_MONITOR_STATUSES: readonly string[] = CLOSE_ON_MATCH_STATUSES.filter(s => s !== 'PENDING' && s !== 'DOWNLOADING');

export type RequestKind = 'issue' | 'annual' | 'collected';

const ANNUAL = /\bannual\b/i;
// A trade's own words. Only read where the series HAS collected books, and never for manga (whose
// volumes are its issues): a single issue's release name seldom says "Vol. 2"; a trade's does.
const COLLECTED = /\b(?:tpb|trade paperback|omnibus|hardcover|vol(?:ume)?\.?\s*\d+)\b/i;

/**
 * What a request is for, read from its name (a request stores no kind): the series' annual when it
 * says "Annual" (unless the series is itself the annual); one of the series' collected books when it
 * is named after one (the series page asks for a trade by its own title, request-name.ts) or says TPB
 * or Vol. N where the series has collected books; otherwise an issue of the run.
 */
export function requestKind(name: string, series: { name: string; isManga: boolean }, collectedNames: string[]): RequestKind {
    const own = name.trim().toLowerCase();
    if (collectedNames.some(c => c.trim().toLowerCase() === own)) return 'collected';
    if (ANNUAL.test(name) && !ANNUAL.test(series.name)) return 'annual';
    if (collectedNames.length > 0 && !series.isManga && COLLECTED.test(name)) return 'collected';
    return 'issue';
}

const SERIES_FIELDS = {
    id: true, name: true, publisher: true, year: true, isManga: true,
    metadataId: true, metadataSource: true, cvId: true, metronId: true,
} as const;
type SeriesRow = Prisma.SeriesGetPayload<{ select: typeof SERIES_FIELDS }>;

const REQUEST_FIELDS = {
    id: true, userId: true, status: true, volumeId: true, metadataSource: true, issueNumber: true,
    activeDownloadName: true, imageUrl: true, user: { select: { username: true, email: true } },
} as const;
type Candidate = Prisma.RequestGetPayload<{ select: typeof REQUEST_FIELDS }>;

/** `special`: the Special's own volume name, when the request was for one (#255) - it names the alert. */
type Closing = { req: Candidate; series: SeriesRow; number: string; annual: boolean; special?: string };
type Via = 'match' | 'monitor';

/** Does a series answer to a request made for (source, volumeId)? */
function seriesAnswers(s: SeriesRow, source: string, volumeId: string): boolean {
    return (s.metadataSource === source && s.metadataId === volumeId)
        || (source === 'COMICVINE' && s.cvId != null && String(s.cvId) === volumeId)
        || (source === 'METRON' && s.metronId != null && String(s.metronId) === volumeId)
        || s.id === volumeId;
}

/** Close the requests in `where` (and in `statuses`) whose issue is in the library; returns how many. */
async function closeFulfilled(where: Prisma.RequestWhereInput, statuses: readonly string[], via: Via): Promise<number> {
    const candidates = (await prisma.request.findMany({
        where: { AND: [where, { status: { in: [...statuses] } }] },
        select: REQUEST_FIELDS,
    })).filter(r => r.volumeId && r.volumeId !== '0' && issueNumberOf(r));
    if (candidates.length === 0) return 0;

    const ids = [...new Set(candidates.map(r => r.volumeId))];
    const numericIds = ids.filter(id => /^\d+$/.test(id)).map(Number);
    const seriesRows = await prisma.series.findMany({
        where: {
            OR: [
                { metadataId: { in: ids } },
                { id: { in: ids } },
                ...(numericIds.length ? [{ cvId: { in: numericIds } }, { metronId: { in: numericIds } }] : []),
            ],
        },
        select: SERIES_FIELDS,
    });
    const attachments = await prisma.attachedVolume.findMany({
        where: { volumeId: { in: ids } },
        select: { id: true, seriesId: true, metadataSource: true, volumeId: true, kind: true, series: { select: SERIES_FIELDS } },
    });
    const seriesIds = [...new Set([...seriesRows.map(s => s.id), ...attachments.map(a => a.seriesId)])];
    if (seriesIds.length === 0) return 0;

    // Every file of those series ('' is no file either), the names of their collected books (to tell a
    // trade's request from an issue's), and what their owned collected books reprint.
    const files = (await prisma.issue.findMany({
        where: { seriesId: { in: seriesIds }, filePath: { not: null } },
        select: { seriesId: true, number: true, isAnnual: true, attachedVolumeId: true, filePath: true },
    })).filter(f => f.filePath);
    const collectedBooks = await prisma.issue.findMany({
        where: { seriesId: { in: seriesIds }, attachedVolume: { kind: 'COLLECTED' } },
        select: { seriesId: true, name: true, attachedVolume: { select: { name: true } } },
    });
    const coverage = await ownedCoverageBySeries({ seriesId: { in: seriesIds } });
    // #255: each series' Specials, by name - a Special's request names the Special, not the series.
    const specials = await prisma.attachedVolume.findMany({
        where: { seriesId: { in: seriesIds }, kind: 'SPECIAL' },
        select: { id: true, seriesId: true, name: true, kind: true },
    });
    const specialsOf = new Map<string, typeof specials>();
    for (const a of specials) specialsOf.set(a.seriesId, [...(specialsOf.get(a.seriesId) ?? []), a]);

    const filesOf = new Map<string, typeof files>();
    for (const f of files) filesOf.set(f.seriesId, [...(filesOf.get(f.seriesId) ?? []), f]);
    const collectedNamesOf = new Map<string, string[]>();
    for (const b of collectedBooks) {
        const names = collectedNamesOf.get(b.seriesId) ?? [];
        for (const n of [b.name, b.attachedVolume?.name]) if (n && !names.includes(n)) names.push(n);
        collectedNamesOf.set(b.seriesId, names);
    }

    const closing: Closing[] = [];
    for (const req of candidates) {
        const number = issueNumberOf(req) as string;
        const source = req.metadataSource || 'COMICVINE';
        const name = req.activeDownloadName || '';
        let hit: Closing | null = null;

        // A request made for an attached volume (an annual, a collected run): that volume's own issue.
        for (const a of attachments) {
            if (hit || a.metadataSource !== source || a.volumeId !== req.volumeId) continue;
            if ((filesOf.get(a.seriesId) ?? []).some(f => f.attachedVolumeId === a.id && isSameIssue(f.number, number))) {
                hit = { req, series: a.series, number, annual: a.kind === 'ANNUAL' };
            }
        }
        for (const s of seriesRows) {
            if (hit || !seriesAnswers(s, source, req.volumeId)) continue;
            // A request named after one of the series' Specials is owned by that Special's own issue alone.
            const special = attachmentForFilename(name, s.name, specialsOf.get(s.id) ?? []);
            if (special) {
                const owned = (filesOf.get(s.id) ?? []).some(f => f.attachedVolumeId === special.id && isSameIssue(f.number, number));
                const specialName = (specials.find(a => a.id === special.id)?.name ?? '').trim();
                if (owned) hit = { req, series: s, number, annual: false, special: specialName || undefined };
                continue;
            }
            const kind = requestKind(name, s, collectedNamesOf.get(s.id) ?? []);
            // A trade's request is left to the person who knows which book it is.
            if (kind === 'collected') continue;
            const rows = filesOf.get(s.id) ?? [];
            const owned = kind === 'annual'
                ? rows.some(f => f.isAnnual && isSameIssue(f.number, number))
                : rows.some(f => !f.isAnnual && !f.attachedVolumeId && isSameIssue(f.number, number))
                    || (coverage.get(s.id) ?? []).some(n => isSameIssue(n, number));
            if (owned) hit = { req, series: s, number, annual: kind === 'annual' };
        }
        if (hit) closing.push(hit);
    }
    if (closing.length === 0) return 0;

    // Un-notified, so the "available" bell fires - the importer closes its requests the same way. The
    // status guard keeps a request that moved on since it was read (a cancel, an import) as it is.
    await prisma.request.updateMany({
        where: { id: { in: closing.map(c => c.req.id) }, status: { in: [...statuses] } },
        data: { status: 'COMPLETED', progress: 100, notified: false },
    });
    const names = closing.map(fullLabelOf);
    Logger.log(
        `[Requests] ${via === 'match' ? 'The match' : 'The Series Monitor'} closed ${closing.length} request(s) whose issue is in the library: ` +
        `${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}.`,
        'info'
    );
    announce(closing, via);
    return closing.length;
}

const labelOf = (c: Closing) => c.special ? `${c.special} #${c.number}` : `${c.annual ? 'Annual ' : ''}#${c.number}`;
/** "Batman Annual #1", or a Special's own "Absolute Batman: Ark-M #1" (its label already names it). */
const fullLabelOf = (c: Closing) => c.special ? labelOf(c) : `${c.series.name} ${labelOf(c)}`;
const inOrder = (a: Closing, b: Closing) =>
    a.series.name.localeCompare(b.series.name)
    || Number(a.annual) - Number(b.annual)
    || (parseFloat(a.number) - parseFloat(b.number))
    || a.number.localeCompare(b.number);

/**
 * The "available" alert - Discord, email, Pushover, Telegram, Apprise - once per requester: a match
 * often closes several of one person's requests, and a monitor run can close a whole backlog after an
 * upgrade. Unlike the importer, it doesn't wait for the requester's other requests in the volume to
 * finish (one stuck request would hold the alert forever). Never awaited, so an unreachable webhook or
 * mail server can't fail or slow the close.
 */
function announce(closing: Closing[], via: Via): void {
    const byUser = new Map<string, Closing[]>();
    for (const c of closing) byUser.set(c.req.userId, [...(byUser.get(c.req.userId) ?? []), c]);
    const lead = via === 'match' ? 'Matched in the Smart Matcher - ' : '';

    for (const items of byUser.values()) {
        items.sort(inOrder);
        const first = items[0];
        const single = new Set(items.map(c => c.series.id)).size === 1 ? first.series : null;
        let title: string;
        let description: string;
        if (single) {
            const labels = [...new Set(items.map(labelOf))];
            title = labels.length === 1 ? fullLabelOf(first) : `${single.name} - ${labels.length} Issues Available!`;
            description = `${lead}${labels.join(', ')} ${labels.length === 1 ? 'is' : 'are'} in your library and ready to read.`;
        } else {
            const names = [...new Set(items.map(fullLabelOf))];
            title = `${names.length} Requested Issues Available!`;
            description = `${lead}${listOf(names)} are in your library and ready to read.`;
        }
        sendAvailableAlert(first.req, title, description, single);
    }
}

/** The first five names, then "and N more". */
function listOf(names: string[]): string {
    const shown = names.slice(0, 5);
    return `${shown.join(', ')}${names.length > shown.length ? ` and ${names.length - shown.length} more` : ''}`;
}

/** One "available" alert, never awaited, so an unreachable webhook or mail server can't fail or slow a close. */
function sendAvailableAlert(req: Candidate, title: string, description: string, series?: SeriesRow | null): void {
    SystemNotifier.sendAlert('comic_available', {
        title,
        imageUrl: req.imageUrl,
        user: req.user?.username,
        email: req.user?.email,
        description,
        publisher: series?.publisher || undefined,
        year: series?.year ? String(series.year) : undefined,
        date: new Date().toLocaleString(),
    }).catch((e: unknown) => Logger.log(`[Requests] Couldn't send the "available" alert to ${req.user?.username || 'the requester'}: ${getErrorMessage(e)}`, 'warn'));
}

/** The Smart Matcher: close every request the series it just matched answers to whose issue is now in
 *  the library - its own provider id, its stored cross-provider ids, its local id, its attached volumes. */
export async function closeRequestsFulfilledBySeries(seriesId: string): Promise<number> {
    const s = await prisma.series.findUnique({
        where: { id: seriesId },
        select: { id: true, metadataId: true, metadataSource: true, cvId: true, metronId: true, attachedVolumes: { select: { metadataSource: true, volumeId: true } } },
    });
    if (!s) return 0;
    const answersTo: Prisma.RequestWhereInput[] = [{ volumeId: s.id }];
    if (s.metadataId) answersTo.push({ metadataSource: s.metadataSource, volumeId: s.metadataId });
    if (s.cvId != null) answersTo.push({ metadataSource: 'COMICVINE', volumeId: String(s.cvId) });
    if (s.metronId != null) answersTo.push({ metadataSource: 'METRON', volumeId: String(s.metronId) });
    for (const a of s.attachedVolumes) answersTo.push({ metadataSource: a.metadataSource, volumeId: a.volumeId });
    return closeFulfilled({ OR: answersTo }, CLOSE_ON_MATCH_STATUSES, 'match');
}

/** The Series Monitor: close every parked request whose issue is in the library, before it re-searches any. */
export async function closeFulfilledParkedRequests(): Promise<number> {
    return closeFulfilled({ volumeId: { notIn: ['0', ''] } }, CLOSE_ON_MONITOR_STATUSES, 'monitor');
}

/**
 * Request Management's "Mark completed" (beta.010): close the requests an admin chose, of those still
 * waiting for their issue (COMPLETABLE_STATUSES), whatever the rule above could tie them to - a
 * MyAnimeList import with no series id, a request against the other provider, a trade. The admin's
 * word is the evidence here. The requester is told once, by each request's own name, unless the admin
 * said not to; the note says who closed it. Returns what closed and the ids it left alone.
 */
export async function markRequestsCompleted(ids: string[], opts: { notify: boolean; by: string }): Promise<{ completed: Candidate[]; skipped: string[] }> {
    const open = await prisma.request.findMany({
        where: { id: { in: ids }, status: { in: [...COMPLETABLE_STATUSES] } },
        select: REQUEST_FIELDS,
    });
    const skipped = ids.filter(id => !open.some(r => r.id === id));
    if (open.length === 0) return { completed: [], skipped };

    // notified: true when the admin chose quiet - as far as the bell is concerned, already told.
    await prisma.request.updateMany({
        where: { id: { in: open.map(r => r.id) }, status: { in: [...COMPLETABLE_STATUSES] } },
        data: { status: 'COMPLETED', progress: 100, notified: !opts.notify, statusNote: `Marked completed by ${opts.by}` },
    });
    const names = open.map(r => r.activeDownloadName || r.id);
    Logger.log(
        `[Requests] ${opts.by} marked ${open.length} request(s) completed${opts.notify ? '' : ' without telling the requester'}: ` +
        `${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}.`,
        'info'
    );

    if (opts.notify) {
        const byUser = new Map<string, Candidate[]>();
        for (const r of open) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
        for (const items of byUser.values()) {
            const own = [...new Set(items.map(r => r.activeDownloadName || 'Your request'))].sort((a, b) => a.localeCompare(b));
            const title = own.length === 1 ? own[0] : `${own.length} Requested Issues Available!`;
            sendAvailableAlert(items[0], title, `${listOf(own)} ${own.length === 1 ? 'is' : 'are'} in your library and ready to read.`);
        }
    }
    return { completed: open, skipped };
}
