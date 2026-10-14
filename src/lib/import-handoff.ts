// src/lib/import-handoff.ts
//
// #240 (realAbitbol, "notify on reality"): a batch download is not an arrival.
//
// The batch path used to mark every request on the link COMPLETED and ring the bell the moment the
// pack was ROUTED to the watched folder — before the sweep had imported anything, and with no way
// back for the packs that never became library issues (a pack with no ComicInfo.xml is parked in
// /unmatched, always). The bell announced issues that were not there.
//
// The handoff separates the two facts. The importer writes one row per file it routes (outcome
// PENDING) and leaves the requests at IMPORTING; the engine stamps each row where the file really
// lands (IMPORTED + the issue id and destination it wrote, or UNMATCHED when it parks the file in
// /unmatched); `reconcileImportHandoffs` — the reconciler in the existing cron — then closes each
// request on what happened: COMPLETED with one "available" alert when the issue is in the library,
// NEEDS_REVIEW with one "needs review" alert when the batch settled without it. The alert follows
// the storage, never the routing.
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { issueIsInLibrary, issueNumberOf } from '@/lib/request-dedupe';
import { SystemNotifier } from '@/lib/notifications';

export const HANDOFF_PENDING = 'PENDING';
export const HANDOFF_IMPORTED = 'IMPORTED';
export const HANDOFF_UNMATCHED = 'UNMATCHED';

// A request that joined an in-flight import (the dedupe's `join` verdict) has no handoff row of its
// own: it waits on the batch it joined. Give that batch time to land before judging the request by
// the library — a sweep that has not run yet must not read as a failed import.
export const IMPORT_RECONCILE_GRACE_MS = 30 * 60 * 1000;

// A request is IMPORTING from the moment its pack is routed until the reconciler closes it. Past
// this, whatever it was waiting on never came back (engine down, sweep never ran, handoff lost) —
// the health check says so, and the reconciler stops waiting on rows nothing will stamp: it judges
// the request by the library and the batch's own tally, exactly like the no-row path (review round,
// hankscafe). Six hours, not three: #240's own logs have the sweep running up to 3 h behind, and a
// sweep at that end of the normal range must not be called stalled before it lands — the bound is
// the headroom over the worst case the incident actually showed.
export const IMPORTING_STALE_MS = 6 * 60 * 60 * 1000;

// The NEEDS_REVIEW re-check is a rescue for a verdict that was true when it was made, minutes to
// hours ago. A row that is still NEEDS_REVIEW days later is a person's to-do item, not something a
// 60 s loop should keep asking the library about, so the re-check only looks at recently touched
// rows.
export const IMPORT_REVIEW_RECHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Settled handoff rows are only ever consulted while their request is IMPORTING, so they can be
// pruned: one row per routed file otherwise accumulates forever, and every reconciler pass scans
// that table for the ids of each IMPORTING request.
export const IMPORT_HANDOFF_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** One id per routed batch. It doubles as the watched-folder job id, so logs line up. */
export function newImportBatchId(): string {
  return `WATCHED_SYNC_BATCH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The key both sides can compute without sharing an absolute path: the file's name relative to the
 * watched folder. The engine looks rows up by exactly this, so it must be produced the same way on
 * both sides — always from the file that ends up in the watched folder (after any re-extension).
 */
export function watchedRelativePath(watchedDir: string, filePath: string): string {
  return path.relative(watchedDir, filePath).split(path.sep).join('/');
}

/**
 * Record one row per routed file, before the sweep is asked to run. Writing rows first is what makes
 * the handoff race-free: a sweep that starts immediately still finds them.
 *
 * For the paths this process routes itself, the row now goes in per file, BEFORE its move
 * (`recordPendingHandoff`) — see that helper. This bulk form is left for the engine-first extraction,
 * whose file names only exist once the engine has written them.
 */
export async function recordImportHandoff(opts: {
  batchId: string;
  requestIds: string[];
  relativePaths: string[];
  volumeId?: string | null;
  metadataSource?: string | null;
}): Promise<number> {
  const relPaths = [...new Set(opts.relativePaths.filter(Boolean))];
  if (relPaths.length === 0) return 0;

  const requestIds = JSON.stringify(opts.requestIds);
  await prisma.$transaction(
    relPaths.map(relPath => prisma.importHandoff.create({
      data: {
        batchId: opts.batchId,
        requestIds,
        relPath,
        volumeId: opts.volumeId ?? null,
        metadataSource: opts.metadataSource ?? null,
        outcome: HANDOFF_PENDING
      }
    }))
  );

  Logger.log(
    `[Import Handoff] Batch ${opts.batchId}: ${relPaths.length} file(s) handed to the watched folder for ${opts.requestIds.length} request(s) (${opts.requestIds.join(', ')}). No alert until the sweep reports back.`,
    'info'
  );
  return relPaths.length;
}

type HandoffRowContext = {
  batchId: string;
  requestIds: string[];
  volumeId?: string | null;
  metadataSource?: string | null;
};

/**
 * One PENDING row, for ONE file, written BEFORE that file is moved into the watched folder (#240
 * review). The order is the point: a sweep that starts while the pack is still being routed finds
 * the row and stamps it, instead of importing a file whose row only appears afterwards — a row
 * nothing will ever settle, which reads as "the batch never reported back" and leaves a request
 * NEEDS_REVIEW over files that are already in the library (and unnumbered requests have no library
 * fallback to rescue them). Best-effort, like the engine's own stamp: a busy database must not fail
 * the import itself.
 */
export async function recordPendingHandoff(opts: HandoffRowContext & { relativePath: string }): Promise<boolean> {
  if (!opts.relativePath) return false;
  try {
    await prisma.importHandoff.create({
      data: {
        batchId: opts.batchId,
        requestIds: JSON.stringify(opts.requestIds),
        relPath: opts.relativePath,
        volumeId: opts.volumeId ?? null,
        metadataSource: opts.metadataSource ?? null,
        outcome: HANDOFF_PENDING
      }
    });
    return true;
  } catch (e: unknown) {
    Logger.log(`[Import Handoff] Could not write the row for "${opts.relativePath}" before routing it: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    return false;
  }
}

/**
 * The file never landed in the watched folder after all (the move failed), so take its row back: a
 * PENDING row that names a file nobody can find is exactly the lie the reconciler then reports as a
 * batch that never came back.
 */
export async function dropPendingHandoff(batchId: string, relativePath: string): Promise<void> {
  if (!relativePath) return;
  try {
    await prisma.importHandoff.deleteMany({
      where: { batchId, relPath: relativePath, outcome: HANDOFF_PENDING }
    });
  } catch (e: unknown) {
    Logger.log(`[Import Handoff] Could not withdraw the row for "${relativePath}": ${e instanceof Error ? e.message : String(e)}`, 'warn');
  }
}

/**
 * The signature fix renamed the file right after it landed (an extension that lied about its
 * format), so its row has to move to the name the engine will actually read. Only a PENDING row is
 * re-keyed: once the sweep has stamped it, the stamp is the truth and the row stays where the
 * engine found it.
 */
export async function rekeyPendingHandoff(batchId: string, from: string, to: string): Promise<void> {
  if (!from || !to || from === to) return;
  try {
    await prisma.importHandoff.updateMany({
      where: { batchId, relPath: from, outcome: HANDOFF_PENDING },
      data: { relPath: to }
    });
  } catch (e: unknown) {
    Logger.log(`[Import Handoff] Could not re-key the row for "${from}" -> "${to}": ${e instanceof Error ? e.message : String(e)}`, 'warn');
  }
}

type ImportingRequest = {
  id: string;
  volumeId: string;
  metadataSource: string;
  issueNumber: string | null;
  activeDownloadName: string | null;
  imageUrl: string | null;
  downloadLink?: string | null;
  updatedAt: Date;
  user?: { username: string | null; email: string | null } | null;
};

type HandoffRow = { outcome: string; batchId?: string; createdAt?: Date };

type HandoffTally = {
  imported: number;
  unmatched: number;
  /** Rows of the batch the sweep never stamped — it may still be running (#240 review). */
  pending?: number;
  reason: 'handoff' | 'no-handoff' | 'recheck';
};

/** What a batch's rows say happened, in the shape the verdict wants. */
function tallyOf(rows: HandoffRow[]): HandoffTally {
  return {
    imported: rows.filter(r => r.outcome === HANDOFF_IMPORTED).length,
    unmatched: rows.filter(r => r.outcome === HANDOFF_UNMATCHED).length,
    pending: rows.filter(r => r.outcome === HANDOFF_PENDING).length,
    reason: 'handoff'
  };
}

/** "issue #37" when the request names one, "the pack" when it does not. */
function whatArrived(issueNumber: string | null, tally: HandoffTally): string {
  if (issueNumber) return `issue #${issueNumber}`;
  const files = tally.imported;
  return files === 1 ? 'one file from this download is' : `${files} files from this download are`;
}

/**
 * The COMPLETED half of the verdict: the issue is in the library, so the request is done — one
 * "available" alert, and `notified: false` so the web bell lines up with it.
 */
async function closeAsCompleted(req: ImportingRequest, tally: HandoffTally): Promise<void> {
  const issueNumber = issueNumberOf(req);
  const label = req.activeDownloadName || (issueNumber ? `Issue #${issueNumber}` : 'Download');
  // A batch serves every request on the link, so the pack's title is the same string for all of
  // them and its file count is the batch's, not this request's. The title leads with the issue this
  // request is for, and falls back to the pack's own name when the request names no issue (#240
  // review, hankscafe).
  const title = issueNumber
    ? `Issue #${issueNumber}${req.activeDownloadName ? ` — ${req.activeDownloadName}` : ''}`
    : tally.imported > 0
      ? `${label} - ${tally.imported} File${tally.imported > 1 ? 's' : ''}`
      : label;

  await prisma.request.update({
    where: { id: req.id },
    data: { status: 'COMPLETED', progress: 100, notified: false }
  });
  await SystemNotifier.sendAlert('comic_available', {
    title,
    imageUrl: req.imageUrl,
    user: req.user?.username,
    email: req.user?.email,
    description: tally.reason === 'recheck'
      ? `The pack has imported since the review — ${issueNumber ? `issue #${issueNumber} is` : 'your issue is'} now in your library and ready to read.`
      : `The download has finished importing — ${whatArrived(issueNumber, tally)} now in your library and ready to read.`,
    date: new Date().toLocaleString()
  }).catch(() => {});
  Logger.log(
    tally.reason === 'recheck'
      ? `[Import Handoff] Reviewed request ${req.id} (${label}) is COMPLETED: the issue is in the library now, without a second import.`
      : `[Import Handoff] Request ${req.id} (${label}) is COMPLETED: the sweep imported ${tally.imported} file(s)${tally.unmatched > 0 ? `, ${tally.unmatched} parked in unmatched` : ''}${issueNumber ? ' and the issue is in the library' : ` and the batch's own rows say it arrived`}.`,
    'info'
  );
}

/**
 * Close one IMPORTING request on what the library says. Same question the dedupe asks before it
 * settles a consumed link (`issueIsInLibrary`), asked once the import has had its chance to land.
 *
 * A request that names no issue is decided by the batch's tally instead: `issueIsInLibrary` is
 * false for it by definition (nothing to look up), and those requests are exactly the ones most
 * likely to come down as a pack and go through the batch path — a manual pack link, a MAL/AniList
 * title import, the admin torrent auto-import (review round, hankscafe). Files that reached the
 * library are an arrival; none is not.
 */
async function closeImportingRequest(req: ImportingRequest, tally: HandoffTally): Promise<'completed' | 'review'> {
  const issueNumber = issueNumberOf(req);
  const owned = issueNumber
    ? await issueIsInLibrary({
        volumeId: req.volumeId,
        metadataSource: req.metadataSource,
        issueNumber
      })
    : tally.imported > 0;

  const label = req.activeDownloadName || (issueNumber ? `Issue #${issueNumber}` : 'Download');

  if (owned) {
    await closeAsCompleted(req, tally);
    return 'completed';
  }

  const missing = issueNumber ? `issue #${issueNumber}` : 'the pack';
  await prisma.request.update({ where: { id: req.id }, data: { status: 'NEEDS_REVIEW' } });
  await SystemNotifier.sendAlert('import_needs_review', {
    title: label,
    imageUrl: req.imageUrl,
    user: req.user?.username,
    email: req.user?.email,
    description: tally.reason === 'handoff'
      ? (tally.pending
          // The batch never finished reporting: say so rather than claim it was handled.
          ? `The download stalled: ${tally.pending} file${tally.pending > 1 ? 's' : ''} of the batch never reported back${tally.unmatched > 0 ? `, and ${tally.unmatched} went to the unmatched folder` : ''}, and ${missing} did not reach your library. Nothing was imported; check the request on the Requests page.`
          : `The download finished, but ${missing} did not reach your library` + (tally.unmatched > 0 ? ` — ${tally.unmatched} file${tally.unmatched > 1 ? 's' : ''} of the batch went to the unmatched folder for review.` : '.') + ' Nothing was imported; check the request on the Requests page.')
      : `The import of this download never reported back, and ${missing} is not in your library. Nothing was imported; check the request on the Requests page.`,
    date: new Date().toLocaleString()
  }).catch(() => {});
  Logger.log(
    `[Import Handoff] Request ${req.id} (${label}) is NEEDS_REVIEW: ${tally.reason === 'handoff' ? `${tally.imported} imported / ${tally.unmatched} unmatched${tally.pending ? ` / ${tally.pending} still pending` : ''}` : 'no handoff row ever reported an outcome'} and ${issueNumber ? 'the issue is' : 'the batch reported nothing'} not in the library.`,
    'warn'
  );
  return 'review';
}

/**
 * The rows of the batch a row-less request joined. A request that joined the wait AFTER its batch
 * was routed has no row of its own — the importer writes one row per file and lists every request
 * on the link in it — so the batch to wait on is the one belonging to the other requests on its
 * download link. Only the newest batch there is consulted: an older settled batch under the same
 * link must not answer for this one.
 */
async function joinedBatchRows(req: { id: string; downloadLink?: string | null }): Promise<HandoffRow[]> {
  if (!req.downloadLink || req.downloadLink === 'PENDING_MATCH') return [];

  const siblings = await prisma.request.findMany({
    where: { downloadLink: req.downloadLink, id: { not: req.id } },
    select: { id: true }
  });
  if (siblings.length === 0) return [];

  const rows = await prisma.importHandoff.findMany({
    where: { OR: siblings.map(s => ({ requestIds: { contains: `"${s.id}"` } })) },
    select: { outcome: true, batchId: true, createdAt: true }
  });
  if (rows.length === 0) return [];

  const newest = rows.reduce((a, r) => ((r.createdAt ?? new Date(0)) > (a.createdAt ?? new Date(0)) ? r : a), rows[0]);
  return rows.filter(r => r.batchId === newest.batchId);
}

/**
 * The reconciler, called from the existing cron. Closes every request held at IMPORTING on what the
 * handoff reported:
 *   - any row still PENDING → the sweep is not done with this batch; wait — but only for
 *     IMPORTING_STALE_MS: past that the batch is judged like any other, so a sweep that never ran
 *     (or an old engine that never stamps) cannot hold a request at IMPORTING forever. The health
 *     check flags the wait either way.
 *   - no row at all → the request joined a batch that was already routed: wait on THAT batch (its
 *     rows are the sibling requests' rows), and only fall back to the 30-minute grace when no
 *     sibling batch can be found. Judging a joiner on the clock alone announces a failed import
 *     while the sweep is still running — the incident's sweeps ran 26 minutes to 3 hours behind. The
 *     wait carries the same IMPORTING_STALE_MS bound: a batch that never finishes stamping is judged
 *     there too, pending rows and all, rather than holding the joiner at IMPORTING forever.
 *   - every row settled → COMPLETED when the issue is in the library (or, for a request that names
 *     no issue, when the batch imported something), NEEDS_REVIEW when it is not.
 *
 * It also re-asks the library for every request already parked at NEEDS_REVIEW, and closes it as
 * COMPLETED the moment the issue is really there: that verdict was true when it was made, not
 * forever — the window between "routed" and "imported" is minutes to hours, and a pack imported by
 * another route than the Smart Matcher lands later too.
 */
export async function reconcileImportHandoffs(
  now: Date = new Date()
): Promise<{ completed: number; review: number; waiting: number }> {
  const importing = await prisma.request.findMany({
    where: { status: 'IMPORTING' },
    select: {
      id: true,
      volumeId: true,
      metadataSource: true,
      issueNumber: true,
      activeDownloadName: true,
      imageUrl: true,
      downloadLink: true,
      updatedAt: true,
      user: { select: { username: true, email: true } }
    }
  });

  const result = { completed: 0, review: 0, waiting: 0 };
  for (const req of importing) {
    const waited = now.getTime() - req.updatedAt.getTime();

    // Request ids are stored as a JSON array, so the quotes make this an exact id match.
    const rows = await prisma.importHandoff.findMany({
      where: { requestIds: { contains: `"${req.id}"` } },
      select: { outcome: true }
    });

    if (rows.length === 0) {
      const joined = await joinedBatchRows(req);
      if (joined.length > 0) {
        // The same bound as a request that has rows of its own: a batch that stopped reporting must
        // not hold a joiner at IMPORTING forever — nothing will ever stamp those rows, and the lead
        // it waits on is judged at the same moment (hankscafe's probe).
        if (joined.some(r => r.outcome === HANDOFF_PENDING) && waited < IMPORTING_STALE_MS) {
          result.waiting++;
          continue;
        }
        const outcome = await closeImportingRequest(req, tallyOf(joined));
        if (outcome === 'completed') result.completed++; else result.review++;
        continue;
      }
      if (waited < IMPORT_RECONCILE_GRACE_MS) {
        result.waiting++;
        continue;
      }
      const outcome = await closeImportingRequest(req, { imported: 0, unmatched: 0, reason: 'no-handoff' });
      if (outcome === 'completed') result.completed++; else result.review++;
      continue;
    }

    const pending = rows.filter(r => r.outcome === HANDOFF_PENDING).length;
    if (pending > 0 && waited < IMPORTING_STALE_MS) {
      result.waiting++;
      continue;
    }

    const outcome = await closeImportingRequest(req, tallyOf(rows));
    if (outcome === 'completed') result.completed++; else result.review++;
  }

  const reviewed = await prisma.request.findMany({
    // Recently touched rows only: see IMPORT_REVIEW_RECHECK_WINDOW_MS.
    where: { status: 'NEEDS_REVIEW', updatedAt: { gte: new Date(now.getTime() - IMPORT_REVIEW_RECHECK_WINDOW_MS) } },
    select: {
      id: true,
      volumeId: true,
      metadataSource: true,
      issueNumber: true,
      activeDownloadName: true,
      imageUrl: true,
      updatedAt: true,
      user: { select: { username: true, email: true } }
    }
  });

  for (const req of reviewed) {
    const issueNumber = issueNumberOf(req);
    // A request that is not for one issue has no number to look for — it waits for a person.
    if (!issueNumber) continue;
    const owned = await issueIsInLibrary({
      volumeId: req.volumeId,
      metadataSource: req.metadataSource,
      issueNumber
    });
    if (!owned) continue;
    await closeAsCompleted(req, { imported: 0, unmatched: 0, reason: 'recheck' });
    result.completed++;
  }

  // Settled rows are never consulted again once their request has left IMPORTING: drop the ones
  // that have outlived the retention window so the table (and the id scan above) stays flat.
  await prisma.importHandoff
    .deleteMany({
      where: {
        outcome: { not: HANDOFF_PENDING },
        createdAt: { lt: new Date(now.getTime() - IMPORT_HANDOFF_RETENTION_MS) }
      }
    })
    .then(deleted => {
      if (deleted?.count) Logger.log(`[Import Handoff] Pruned ${deleted.count} settled handoff row(s) older than 30 days.`, 'debug');
    })
    .catch(() => {});

  return result;
}
