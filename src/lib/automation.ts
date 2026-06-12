// src/lib/automation.ts
// The live search path is the Rust engine: searchAndDownload() enqueues a BullMQ
// SEARCH_AND_DOWNLOAD job, and queue.ts forwards it to the engine's /api/automation/search.
// The legacy full-Node search (executeSearchAndDownload) was removed as dead code.

// Local helper to safely compare issue numbers with formatting discrepancies (e.g., "01" vs "1")
export function looseCompareIssue(num1: string | number, num2: string | number): boolean {
    const regex = /^0*(\d*(?:\.\d+)?)(.*)$/;
    const m1 = String(num1).trim().match(regex);
    const m2 = String(num2).trim().match(regex);

    if (!m1 || !m2) return String(num1).toUpperCase() === String(num2).toUpperCase();
    const float1 = parseFloat(m1[1] || "0");
    const float2 = parseFloat(m2[1] || "0");
    const suffix1 = m1[2].toUpperCase().trim();
    const suffix2 = m2[2].toUpperCase().trim();
    return float1 === float2 && suffix1 === suffix2;
}

let nextAvailableSearchTime = Date.now();

export async function searchAndDownload(requestId: string, name: string, year: string, publisher?: string, isManga: boolean = false, skipIndexers: boolean = false) {
  const now = Date.now();
  if (nextAvailableSearchTime < now) {
      nextAvailableSearchTime = now;
  }
  const delayMs = nextAvailableSearchTime - now;
  nextAvailableSearchTime += 5000;

  const { omnibusQueue } = await import('@/lib/queue');
  await omnibusQueue.add('SEARCH_AND_DOWNLOAD', {
    type: 'SEARCH_AND_DOWNLOAD',
    requestId, name, year, publisher, isManga, skipIndexers
  }, {
    jobId: `SEARCH_${requestId}`,
    delay: delayMs
  });
}

export async function processAutomationQueue(items: any[]) {
  for (const item of items) {
    await searchAndDownload(item.id, item.name, item.year, item.publisher, item.isManga, item.skipIndexers);
  }
}
