// src/lib/request-dedupe.ts
//
// #240 (realAbitbol): one pack, one download. A `Request` that shares a download link with another
// request is normally parked as DOWNLOADING "for batch extraction" — the importer's shared-link
// sweep (updateMany on downloadLink) then closes every row on that link when the single download
// imports. That only works while the link is being downloaded: once the lead request has FINISHED,
// its pack has already been routed to the watched folder and deleted, so a later request parked on
// the same link is never closed by anything and stays DOWNLOADING forever — and the monitor, seeing
// no live request for its issue, searches and downloads the same pack again. Three waves of that in
// one night in the incident.
//
// The rule this module implements: a link whose earlier request has finished is never a reason to
// park. The new request is settled instead — COMPLETED when its issue really is in the library now,
// NEEDS_REVIEW when the bytes were consumed but the issue never arrived (the pack landed in
// /unmatched) — and nothing is downloaded either way.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { isSameIssue } from '@/lib/utils/issue-parser';
import { ownedCoverageBySeries } from '@/lib/coverage-ownership';

// The statuses that mean "this request still owns its link": a sibling in one of them is a genuine
// wait-for-it duplicate. DOWNLOADING is the only in-flight one.
export const IN_FLIGHT_REQUEST_STATUS = 'DOWNLOADING';
export const FINISHED_REQUEST_STATUSES = ['IMPORTED', 'COMPLETED'];
const LINK_OCCUPYING_STATUSES = [IN_FLIGHT_REQUEST_STATUS, ...FINISHED_REQUEST_STATUSES];

export type DuplicateLinkVerdict =
  /** Nothing else holds this link — download normally. */
  | { action: 'download' }
  /** A sibling is still downloading it: park and let the shared-link sweep close us out. */
  | { action: 'park' }
  /** Every sibling has finished (bytes gone) — the request was settled, download nothing. */
  | { action: 'settle'; status: 'COMPLETED' | 'NEEDS_REVIEW'; reason: 'in-library' | 'unmatched' };

/**
 * The identity of the issue a request is for: the stored column first, and — for rows created
 * before it existed — the issue number parsed out of the download name (the parse the monitor has
 * always used). Pure so the monitor's dedupe stays testable without a database.
 *
 * The name pattern is dev's monitor pattern verbatim, negative sign included: a request for an
 * annual-ish "-1" is still identified by its name when no number was stored.
 */
export function issueNumberOf(req: { issueNumber?: string | null; activeDownloadName?: string | null }): string | null {
  const stored = (req.issueNumber || '').trim();
  if (stored) return stored;
  const match = (req.activeDownloadName || '').match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?[a-zA-Z]?)/i);
  return match ? match[1] : null;
}

/**
 * Does the settle's `notified: true` hold for this request? It is claimed on the grounds that the
 * pack's own import already told the requester the issue is available — which is only true when a
 * FINISHED request on the link belongs to the SAME user. A request that met someone else's
 * consumed link was never announced anything, so it closes with `notified: false` and the
 * "available" bell fires for it.
 */
export function notifiedOnSettle(
  siblings: { status: string; userId?: string | null }[],
  requestUserId?: string | null
): boolean {
  if (!requestUserId) return false;
  return siblings.some(s => FINISHED_REQUEST_STATUSES.includes(s.status) && s.userId === requestUserId);
}

/**
 * A request that shares this link with others, and what to do about it. `siblingStatuses` is what
 * the OTHER requests on the link are in; `issueOwned` says whether the issue this request is for is
 * already on disk in the library.
 */
export function verdictForLinkSiblings(siblingStatuses: string[], issueOwned: boolean): DuplicateLinkVerdict {
  if (siblingStatuses.length === 0) return { action: 'download' };
  if (siblingStatuses.includes(IN_FLIGHT_REQUEST_STATUS)) return { action: 'park' };
  return issueOwned
    ? { action: 'settle', status: 'COMPLETED', reason: 'in-library' }
    : { action: 'settle', status: 'NEEDS_REVIEW', reason: 'unmatched' };
}

/**
 * Is this issue already in the library? Same ownership question the request routes ask before
 * creating a request at all (a file-backed run issue of the series, or one reprinted by an owned
 * collected edition), answered for a (volume, issue number) pair instead of an in-memory set.
 */
export async function issueIsInLibrary(opts: {
  volumeId?: string | null;
  metadataSource?: string | null;
  issueNumber?: string | null;
}): Promise<boolean> {
  const volumeId = opts.volumeId;
  const issueNumber = (opts.issueNumber || '').trim();
  if (!volumeId || volumeId === '0' || !issueNumber) return false;

  // A request's volumeId is a provider volume id, but rows written by older paths carry the local
  // Series id — accept either, exactly like the monitor's own series lookup does.
  const series = await prisma.series.findFirst({
    where: opts.metadataSource
      ? { OR: [{ metadataId: volumeId, metadataSource: opts.metadataSource }, { id: volumeId }] }
      : { OR: [{ metadataId: volumeId }, { id: volumeId }] },
    select: { id: true }
  });
  if (!series) return false;

  const files = await prisma.issue.findMany({
    where: { seriesId: series.id, filePath: { not: null } },
    select: { number: true }
  });
  const covered = (await ownedCoverageBySeries({ seriesId: series.id })).get(series.id) || [];
  return [...files.map(f => f.number), ...covered].some(n => isSameIssue(n, issueNumber));
}

/**
 * Settle a request against the other requests holding its download link. Called wherever a request
 * is about to be parked on a link someone else already owns (the search path, the manual and retry
 * routes, the admin download panel). Returns what the caller should do: `download` (proceed),
 * `park` (today's behaviour) or `settle` (the request was closed here — download nothing).
 *
 * The request's own row supplies its identity, so every call site behaves identically.
 */
export async function settleDuplicateOnLink(link: string | null | undefined, requestId: string): Promise<DuplicateLinkVerdict> {
  if (!link) return { action: 'download' };

  const siblings = await prisma.request.findMany({
    where: { downloadLink: link, id: { not: requestId }, status: { in: LINK_OCCUPYING_STATUSES } },
    select: { id: true, status: true, userId: true }
  });
  if (siblings.length === 0) return { action: 'download' };

  if (siblings.some(s => s.status === IN_FLIGHT_REQUEST_STATUS)) {
    return verdictForLinkSiblings(siblings.map(s => s.status), false);
  }

  const req = await prisma.request.findUnique({
    where: { id: requestId },
    select: { volumeId: true, metadataSource: true, issueNumber: true, activeDownloadName: true, userId: true }
  });
  const issueNumber = req ? issueNumberOf(req) : null;
  const owned = issueNumber
    ? await issueIsInLibrary({ volumeId: req?.volumeId, metadataSource: req?.metadataSource, issueNumber })
    : false;

  const verdict = verdictForLinkSiblings(siblings.map(s => s.status), owned);
  if (verdict.action !== 'settle') return verdict;

  await prisma.request.update({
    where: { id: requestId },
    data: verdict.status === 'COMPLETED'
      // `notified` follows who was already told. The pack's own import announced the issue to the
      // user whose request consumed the link — so only a request of THAT user can claim it was
      // already notified, and stay quiet. A request meeting another user's finished link closes
      // with `notified: false`: nobody ever announced this issue to them.
      ? { status: 'COMPLETED', progress: 100, notified: notifiedOnSettle(siblings, req?.userId) }
      : { status: 'NEEDS_REVIEW' }
  });
  Logger.log(
    verdict.reason === 'in-library'
      ? `[Dedupe] ${issueNumber ? `Issue #${issueNumber} is` : 'The issue is'} already in the library — closing the duplicate request on the consumed link (${link}) as COMPLETED instead of parking it.`
      : `[Dedupe] The link (${link}) was already consumed by a finished request and ${issueNumber ? `issue #${issueNumber} is` : 'the issue is'} not in the library — closing the duplicate as NEEDS_REVIEW. Review the pack in the unmatched folder.`,
    'warn'
  );
  return verdict;
}
