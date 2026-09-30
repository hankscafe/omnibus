// src/lib/metadata/providers/metron-cover.ts
import { getMetronAuth, metronGet, MetronAuth } from '@/lib/metron/client';

/**
 * Lightweight Metron cover lookup, used as a fallback when ComicVine has no image. Callers fire it for
 * several items at once while a page loads, so it is an optional request through the shared Metron
 * client: it goes out only while Metron's burst window has a free slot and is skipped (null)
 * otherwise - a later page load tries again. `auth`: pass the credentials when looking up many covers
 * (one settings read); omitted, the configured ones are read.
 */
export async function getMetronCover(seriesName: string, issueNumber: string, auth?: MetronAuth | null): Promise<string | null> {
    const credentials = auth === undefined ? await getMetronAuth() : auth;
    if (!credentials) return null;
    try {
        const url = `https://metron.cloud/api/issue/?series_name=${encodeURIComponent(seriesName)}&number=${encodeURIComponent(issueNumber)}`;
        const res = await metronGet(url, { auth: credentials, pace: 'interactive', optional: true, maxAttempts: 1, timeoutMs: 4000 });
        return res.data?.results?.[0]?.image || null;
    } catch {
        return null;
    }
}
