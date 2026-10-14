// src/lib/automation.ts
// The live search path is the Rust engine: searchAndDownload() enqueues a BullMQ
// SEARCH_AND_DOWNLOAD job, and queue.ts forwards it to the engine's /api/automation/search.
// The legacy full-Node search (executeSearchAndDownload) was removed as dead code.

let nextAvailableSearchTime = Date.now();

// #240 finding 3 (hankscafe): BullMQ serves the plain wait list BEFORE the prioritized set — the
// worker's `moveToActive-11.lua` pops `wait` first and only then `ZPOPMIN`s `prioritized` — so a job
// with no priority is taken before any prioritized job. Searches are the bulk of this queue, so they
// are the ones given a LOW priority (10, out of 2^21; a higher number means later) and every scheduled
// job — the per-batch watched-folder trigger, the 15-minute sweep, the reconciler — jumps ahead of the
// search backlog instead of waiting behind it.
//
// The 5-second throttle below delays a search rather than dropping it, and a delayed job keeps this
// priority: when the worker promotes it out of `delayed`, `promoteDelayedJobs.lua` reads the job's own
// priority and puts it in the prioritized set rather than the wait list. (The bulk
// `moveJobsToWait-8.lua`, used by the queue API and not by workers, is the one that ignores
// priorities — that is not the path a search takes here.)
//
// Consequence to keep in mind: a queued search now sits in the `prioritized` state, so anything that
// looks it up by state has to ask for it — the cancel and retry routes do (see `getJobs` there).
export const SEARCH_JOB_PRIORITY = 10;

export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const now = Date.now();
  if (nextAvailableSearchTime < now) {
      nextAvailableSearchTime = now;
  }
  const delayMs = nextAvailableSearchTime - now;
  nextAvailableSearchTime += 5000;

  const { omnibusQueue } = await import('@/lib/queue');
  const jobId = `SEARCH_${requestId}`;
  // #240: BullMQ ignores an add whose job id still exists - including a FINISHED job it keeps
  // (removeOnComplete: 100) - so a re-search after a failed or refused download (cron re-queue,
  // importer refusal, the retry route) was silently dropped. Clear a finished one first; a search
  // that is still pending keeps the id, so the same request is never searched twice at once.
  try {
    const previous = await omnibusQueue.getJob(jobId);
    if (previous) {
      const state = await previous.getState();
      if (state === 'completed' || state === 'failed') await previous.remove();
    }
  } catch { /* can't inspect the queue: add anyway */ }
  await omnibusQueue.add('SEARCH_AND_DOWNLOAD', {
    type: 'SEARCH_AND_DOWNLOAD',
    requestId, name, year, publisher, isManga, skipIndexers
  }, {
    jobId,
    delay: delayMs,
    priority: SEARCH_JOB_PRIORITY
  });
}

export async function processAutomationQueue(items: any[]) {
  for (const item of items) {
    await searchAndDownload(item.id, item.name, item.year, item.publisher, item.isManga, item.skipIndexers);
  }
}
