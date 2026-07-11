// src/lib/metadata/metadata-cache.ts
//
// Shared ComicVine/Metron response cache (opt-in, metadata_cache_enabled — Settings → Metadata).
// Node and the Rust engine read/write the same MetadataCache table, so a response either side
// fetched is a saved API call for both. Design notes:
//   - Keys are sha256 of the NORMALIZED url: the CV api_key query param is stripped so a key
//     rotation doesn't orphan the cache (and the key never lands in a table column).
//   - Expiry is computed AT READ TIME from createdAt + the CURRENT admin TTLs, so changing the
//     TTL settings applies to already-cached entries immediately.
//   - Only 200-JSON bodies under MAX_CACHE_BODY_BYTES are stored; errors and giant pages pass
//     through uncached. Usage accounting (logApiUsage) must only run for REAL upstream calls —
//     cachedCvGet owns that; Metron callers branch on the `cached` flag.
//   - Engine parity: omnibus-engine/src/metadata_cache.rs implements the same normalization,
//     classification, and TTL rules. Change one, change both.
import crypto from 'crypto';
import { apiClient } from '@/lib/api-client';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { logApiUsage } from '@/lib/utils/system-flags';

export const MAX_CACHE_BODY_BYTES = 512 * 1024;

export type CacheKind = 'detail' | 'list';

/** Strips volatile/secret query params (the CV api_key) and normalizes for a stable key. */
export function normalizeCacheUrl(url: string): string {
    try {
        const u = new URL(url);
        u.searchParams.delete('api_key');
        u.searchParams.sort();
        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Cache class of a provider URL — or null for URLs that must never be cached.
 *   detail — immutable-ish by-id lookups (CV /volume/4050-*, /issue/4000-*, /story_arc/*;
 *            Metron /issue/{id}/, /series/{id}/): long TTL (metadata_cache_detail_days).
 *   list   — searches and paginated lists (CV /search, /issues, /volumes; Metron issue_list,
 *            ?name= lookups): short TTL (metadata_cache_list_hours).
 */
export function classifyProviderUrl(url: string): CacheKind | null {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        return null;
    }
    // ComicVine: /api/<resource>/<typeid>-<id>/ = detail; /api/<resource>s/ or /api/search = list.
    if (/\/api\/(volume|issue|story_arc|person|character)\/\d{4}-\d+/i.test(pathname)) return 'detail';
    if (/\/api\/(search|issues|volumes|story_arcs|characters|people)\/?$/i.test(pathname)) return 'list';
    // Metron: /api/<resource>/<numeric id>/ = detail; bare /api/<resource>/ (name= / list / cv_id=
    // filters live in the query string) = list. issue_list is a list under a series detail path.
    if (/\/api\/series\/\d+\/issue_list\/?$/i.test(pathname)) return 'list';
    if (/\/api\/(issue|series|arc|character|team|publisher)\/\d+\/?$/i.test(pathname)) return 'detail';
    if (/\/api\/(issue|series|arc|character|team|publisher)\/?$/i.test(pathname)) return 'list';
    return null;
}

export function cacheKey(provider: 'comicvine' | 'metron', normalizedUrl: string): string {
    return `${provider}:${crypto.createHash('sha256').update(normalizedUrl).digest('hex')}`;
}

async function cacheEnabled(): Promise<boolean> {
    try {
        const s = await prisma.systemSetting.findUnique({ where: { key: 'metadata_cache_enabled' } });
        return s?.value === 'true';
    } catch {
        return false;
    }
}

/** Current TTL in ms for a cache kind, from the admin settings (read live so changes apply now). */
async function ttlMsFor(kind: CacheKind): Promise<number> {
    const key = kind === 'detail' ? 'metadata_cache_detail_days' : 'metadata_cache_list_hours';
    const fallback = kind === 'detail' ? 7 : 12;
    const unitMs = kind === 'detail' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    try {
        const s = await prisma.systemSetting.findUnique({ where: { key } });
        const n = parseFloat(s?.value || '');
        return (isNaN(n) || n <= 0 ? fallback : n) * unitMs;
    } catch {
        return fallback * unitMs;
    }
}

/** Cached body for `url` (parsed JSON), or null on miss/expired/disabled/uncacheable. */
export async function getCachedResponse(provider: 'comicvine' | 'metron', url: string): Promise<any | null> {
    const kind = classifyProviderUrl(url);
    if (!kind || !(await cacheEnabled())) return null;
    try {
        const normalized = normalizeCacheUrl(url);
        const row = await prisma.metadataCache.findUnique({ where: { key: cacheKey(provider, normalized) } });
        if (!row) return null;
        if (Date.now() - row.createdAt.getTime() > (await ttlMsFor(row.kind as CacheKind))) return null;
        return JSON.parse(row.value);
    } catch (e) {
        Logger.log(`[MetadataCache] Read failed for ${url}: ${getErrorMessage(e)}`, 'debug');
        return null;
    }
}

/** Stores a 200-JSON body (stringified) under `url`. Best-effort; oversized bodies are skipped. */
export async function putCachedResponse(provider: 'comicvine' | 'metron', url: string, body: any): Promise<void> {
    const kind = classifyProviderUrl(url);
    if (!kind || !(await cacheEnabled())) return;
    try {
        const value = JSON.stringify(body);
        if (Buffer.byteLength(value) > MAX_CACHE_BODY_BYTES) return;
        const normalized = normalizeCacheUrl(url);
        const key = cacheKey(provider, normalized);
        // Refresh createdAt on rewrite — a fresh fetch restarts the TTL clock.
        await prisma.metadataCache.upsert({
            where: { key },
            update: { value, kind, createdAt: new Date() },
            create: { key, url: normalized, kind, value }
        });
    } catch (e) {
        Logger.log(`[MetadataCache] Write failed for ${url}: ${getErrorMessage(e)}`, 'debug');
    }
}

/** Folds axios-style `opts.params` into the URL so the cache key sees the FULL request. */
function effectiveUrl(url: string, opts?: any): string {
    if (!opts?.params) return url;
    try {
        const u = new URL(url);
        for (const [k, v] of Object.entries(opts.params)) {
            if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Drop-in replacement for `axios.get(url, opts)` on ComicVine URLs: serves from the shared cache
 * when enabled and fresh, else fetches, caches a 200 body, and logs the REAL call against the CV
 * usage window (call sites must NOT also call logApiUsage — that would double-count).
 * `bypassCache` (user-initiated refresh) skips the read but still refreshes the stored entry.
 */
export async function cachedCvGet(url: string, opts?: any, bypassCache = false): Promise<{ data: any; cached: boolean }> {
    const fullUrl = effectiveUrl(url, opts);
    if (!bypassCache) {
        const hit = await getCachedResponse('comicvine', fullUrl);
        if (hit !== null) return { data: hit, cached: true };
    }
    // The pooled apiClient (keep-alive agents) — every swept call site gains connection reuse.
    const res = await apiClient.get(url, opts);
    // Coarse endpoint key ('/volume', '/issues', '/search') — the format the existing Node call
    // sites already write, so the health panel's usage JSON doesn't fragment into per-id keys.
    const endpoint = '/' + (new URL(url).pathname.replace(/^\/api\//, '').split('/')[0] || 'unknown');
    try { await logApiUsage('comicvine', endpoint); } catch { /* accounting must never fail a fetch */ }
    if (res.status === 200 && res.data && typeof res.data === 'object') {
        await putCachedResponse('comicvine', fullUrl, res.data);
    }
    return { data: res.data, cached: false };
}
