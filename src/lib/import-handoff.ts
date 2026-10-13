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
// the health check says so, and a person looks; the reconciler never invents an outcome.
export const IMPORTING_STALE_MS = 3 * 60 * 60 * 1000;

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

type ImportingRequest = {
  id: string;
  volumeId: string;
  metadataSource: string;
  issueNumber: string | null;
  activeDownloadName: string | null;
  imageUrl: string | null;
  updatedAt: Date;
  user?: { username: string | null; email: string | null } | null;
};

type HandoffTally = { imported: number; unmatched: number; reason: 'handoff' | 'no-handoff' | 'recheck' };

/**
 * The COMPLETED half of the verdict: the issue is in the library, so the request is done — one
 * "available" alert, and `notified: false` so the web bell lines up with it.
 */
async function closeAsCompleted(req: ImportingRequest, tally: HandoffTally): Promise<void> {
  const issueNumber = issueNumberOf(req);
  const label = req.activeDownloadName || (issueNumber ? `Issue #${issueNumber}` : 'Download');

  await prisma.request.update({
    where: { id: req.id },
    data: { status: 'COMPLETED', progress: 100, notified: false }
  });
  await SystemNotifier.sendAlert('comic_available', {
    title: tally.imported > 0 ? `${label} - ${tally.imported} File${tally.imported > 1 ? 's' : ''}` : label,
    imageUrl: req.imageUrl,
    user: req.user?.username,
    email: req.user?.email,
    description: tally.reason === 'recheck'
      ? `The pack has imported since the review — ${issueNumber ? `issue #${issueNumber} is` : 'your issue is'} now in your library and ready to read.`
      : `The download has finished importing — ${issueNumber ? `issue #${issueNumber} is` : 'your issue is'} now in your library and ready to read.`,
    date: new Date().toLocaleString()
  }).catch(() => {});
  Logger.log(
    tally.reason === 'recheck'
      ? `[Import Handoff] Reviewed request ${req.id} (${label}) is COMPLETED: the issue is in the library now, without a second import.`
      : `[Import Handoff] Request ${req.id} (${label}) is COMPLETED: the sweep imported ${tally.imported} file(s)${tally.unmatched > 0 ? `, ${tally.unmatched} parked in unmatched` : ''} and the issue is in the library.`,
    'info'
  );
}

/**
 * Close one IMPORTING request on what the library says. Same question the dedupe asks before it
 * settles a consumed link (`issueIsInLibrary`), asked once the import has had its chance to land.
 */
async function closeImportingRequest(req: ImportingRequest, tally: HandoffTally): Promise<'completed' | 'review'> {
  const issueNumber = issueNumberOf(req);
  const owned = await issueIsInLibrary({
    volumeId: req.volumeId,
    metadataSource: req.metadataSource,
    issueNumber
  });

  const label = req.activeDownloadName || (issueNumber ? `Issue #${issueNumber}` : 'Download');

  if (owned) {
    await closeAsCompleted(req, tally);
    return 'completed';
  }

  await prisma.request.update({ where: { id: req.id }, data: { status: 'NEEDS_REVIEW' } });
  await SystemNotifier.sendAlert('import_needs_review', {
    title: label,
    imageUrl: req.imageUrl,
    user: req.user?.username,
    email: req.user?.email,
    description: tally.reason === 'handoff'
      ? `The download finished, but ${issueNumber ? `issue #${issueNumber}` : 'the issue'} did not reach your library` + (tally.unmatched > 0 ? ` — ${tally.unmatched} file${tally.unmatched > 1 ? 's' : ''} of the batch went to the unmatched folder for review.` : '.') + ' Nothing was imported; check the request on the Requests page.'
      : `The import of this download never reported back, and ${issueNumber ? `issue #${issueNumber}` : 'the issue'} is not in your library. Nothing was imported; check the request on the Requests page.`,
    date: new Date().toLocaleString()
  }).catch(() => {});
  Logger.log(
    `[Import Handoff] Request ${req.id} (${label}) is NEEDS_REVIEW: ${tally.reason === 'handoff' ? `${tally.imported} imported / ${tally.unmatched} unmatched` : 'no handoff row ever reported an outcome'} and the issue is not in the library.`,
    'warn'
  );
  return 'review';
}

/**
 * The reconciler, called from the existing cron. Closes every request held at IMPORTING on what the
 * handoff reported:
 *   - any row still PENDING → the sweep is not done with this batch; wait (this is the "still
 *     pending" state — a batch whose sweep never runs stays here for the health check to flag).
 *   - no row at all → the request joined an in-flight batch, or predates the handoff; wait out the
 *     grace period, then judge it by the library rather than leave it IMPORTING forever.
 *   - every row settled → COMPLETED when the issue is in the library, NEEDS_REVIEW when it is not.
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
      updatedAt: true,
      user: { select: { username: true, email: true } }
    }
  });

  const result = { completed: 0, review: 0, waiting: 0 };
  if (importing.length > 0) {
    for (const req of importing) {
      // Request ids are stored as a JSON array, so the quotes make this an exact id match.
      const rows = await prisma.importHandoff.findMany({
        where: { requestIds: { contains: `"${req.id}"` } },
        select: { outcome: true }
      });

      if (rows.length === 0) {
        if (now.getTime() - req.updatedAt.getTime() < IMPORT_RECONCILE_GRACE_MS) {
          result.waiting++;
          continue;
        }
        const outcome = await closeImportingRequest(req, { imported: 0, unmatched: 0, reason: 'no-handoff' });
        if (outcome === 'completed') result.completed++; else result.review++;
        continue;
      }

      const pending = rows.filter(r => r.outcome === HANDOFF_PENDING).length;
      if (pending > 0) {
        result.waiting++;
        continue;
      }

      const tally: HandoffTally = {
        imported: rows.filter(r => r.outcome === HANDOFF_IMPORTED).length,
        unmatched: rows.filter(r => r.outcome === HANDOFF_UNMATCHED).length,
        reason: 'handoff'
      };
      const outcome = await closeImportingRequest(req, tally);
      if (outcome === 'completed') result.completed++; else result.review++;
    }
  }

  const reviewed = await prisma.request.findMany({
    where: { status: 'NEEDS_REVIEW' },
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

  return result;
}
