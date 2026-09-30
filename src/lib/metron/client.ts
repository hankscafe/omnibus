// src/lib/metron/client.ts
//
// The Node app's one Metron API client (Metron's published best practices; #216 follow-up) - the twin
// of the engine's metron_client.rs. Every Node call to the Metron API goes through `metronGet`, which:
// - authenticates with an API token (`Authorization: Bearer`) when one is configured, else HTTP Basic
//   with the username/password (Metron is retiring Basic auth);
// - paces from Metron's own X-RateLimit-* headers the way their reference client (Mokkari's
//   HeaderPacedRateLimiter) does: a rolling log of our sends against the burst (per-minute) limit the
//   server reports, background work spaced evenly across that window (interactive requests - someone
//   waiting on a page - only have to fit inside it), a 429 blocks every caller for its Retry-After, and
//   an exhausted daily (sustained) window stops work instead of waiting hours;
// - retries only 429 and 5xx (5xx with exponential backoff, 1 s doubling to a 60 s cap), never
//   another 4xx;
// - shares the latest rate-limit state through SystemSetting `metron_rate_status`, which the engine
//   reads and writes too - both processes use the same Metron account;
// - identifies itself as `Omnibus/<version> (+repo URL)` and counts every request it sends.
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getCachedResponse, putCachedResponse } from '@/lib/metadata/metadata-cache';
import { logApiUsage, markSystemFlag } from '@/lib/utils/system-flags';
import packageJson from '../../../package.json';
import { BASE_DAILY_LIMIT, isNum, type RateStatus, type RateWindow } from './health';

export const METRON_PROJECT_URL = 'https://github.com/hankscafe/omnibus';
export const METRON_USER_AGENT = `Omnibus/${packageJson.version} (+${METRON_PROJECT_URL})`;
export const METRON_RATE_STATUS_KEY = 'metron_rate_status';

const BURST_PERIOD_MS = 60_000;
const DEFAULT_BURST_LIMIT = 20; // Metron's documented floor, until a response reports the real limit
const MAX_INLINE_WAIT_S = 60; // a longer 429 (or block) stops the work instead of waiting it out

// ------------------------------------------------------------------ auth

export type MetronAuth = { kind: 'token'; token: string } | { kind: 'basic'; user: string; pass: string };

/** A usable credential value: not blank, and not the settings UI's `********` mask. */
function usable(value: string | null | undefined): string | null {
    const v = (value ?? '').trim();
    return v && v !== '********' ? v : null;
}

/** Picks the credentials from (decrypted) settings: a token wins, else username + password. */
export function authFromSettings(token?: string | null, user?: string | null, pass?: string | null): MetronAuth | null {
    const t = usable(token);
    if (t) return { kind: 'token', token: t };
    const u = usable(user);
    const p = usable(pass);
    return u && p ? { kind: 'basic', user: u, pass: p } : null;
}

/** The configured Metron credentials (the Prisma client decrypts the secrets on read). */
export async function getMetronAuth(): Promise<MetronAuth | null> {
    const rows = await prisma.systemSetting.findMany({
        where: { key: { in: ['metron_api_token', 'metron_user', 'metron_pass'] } },
    });
    const config = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
    return authFromSettings(config.metron_api_token, config.metron_user, config.metron_pass);
}

/**
 * A getter that reads the credentials at most once, and only if called - for a request handler that
 * may or may not need Metron (e.g. a cover fallback for some items).
 */
export function lazyMetronAuth(): () => Promise<MetronAuth | null> {
    let pending: Promise<MetronAuth | null> | null = null;
    return () => (pending ??= getMetronAuth());
}

export function authHeader(auth: MetronAuth): string {
    return auth.kind === 'token'
        ? `Bearer ${auth.token}`
        : `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
}

// ------------------------------------------------------------------ rate-limit state

// The state types, the tier and the Health line live in ./health (client-safe, for the Health modal).
export type { RateWindow, RateStatus } from './health';
export { describeMetronHealth } from './health';

/** Reads `X-RateLimit-{Burst,Sustained}-{Limit,Remaining,Reset}`. */
export function parseRateHeaders(headers: Headers): { burst: RateWindow; sustained: RateWindow } {
    const window = (scope: string): RateWindow => {
        const w: RateWindow = {};
        for (const field of ['limit', 'remaining', 'reset'] as const) {
            const raw = headers.get(`x-ratelimit-${scope}-${field}`);
            const n = raw === null ? NaN : parseInt(raw.trim(), 10);
            if (Number.isFinite(n)) w[field] = n;
        }
        return w;
    };
    return { burst: window('burst'), sustained: window('sustained') };
}

/** A used-up window whose reset is still ahead: ms until the reset, else null. */
function exhaustedForMs(w: RateWindow | undefined, nowMs: number): number | null {
    if (!w || !isNum(w.remaining) || !isNum(w.reset)) return null;
    return w.remaining <= 0 && w.reset * 1000 > nowMs ? w.reset * 1000 - nowMs : null;
}

export type MetronPace = 'interactive' | 'background';

/** This process's pacing state. Time is passed in (epoch ms) so the rules are testable. */
export class MetronLimiter {
    private sends: number[] = [];
    private lastSend: number | null = null;
    private burstLimit: number | null = null;
    private blockedUntil = 0;
    private sustained: RateWindow = {};

    private limit(): number {
        return this.burstLimit && this.burstLimit > 0 ? this.burstLimit : DEFAULT_BURST_LIMIT;
    }

    /** Milliseconds to wait before the next send (0 = now), or a daily-limit refusal. */
    waitMs(nowMs: number, pace: MetronPace, shared: RateStatus): number | { dailyLimitRetryAfterS: number } {
        for (const w of [this.sustained, shared.sustained]) {
            const ms = exhaustedForMs(w, nowMs);
            if (ms !== null) return { dailyLimitRetryAfterS: Math.ceil(ms / 1000) };
        }

        let wait = this.blockedUntil - nowMs;
        if (isNum(shared.blockedUntil)) wait = Math.max(wait, shared.blockedUntil - nowMs);
        const burstEmpty = exhaustedForMs(shared.burst, nowMs);
        if (burstEmpty !== null) wait = Math.max(wait, burstEmpty);

        const limit = this.limit();
        while (this.sends.length && this.sends[0] <= nowMs - BURST_PERIOD_MS) this.sends.shift();
        if (this.sends.length >= limit) {
            wait = Math.max(wait, this.sends[this.sends.length - limit] + BURST_PERIOD_MS - nowMs);
        }
        if (pace === 'background' && this.lastSend !== null) {
            wait = Math.max(wait, this.lastSend + BURST_PERIOD_MS / limit - nowMs);
        }
        return Math.max(0, wait);
    }

    recordSend(nowMs: number) {
        this.sends.push(nowMs);
        this.lastSend = nowMs;
    }

    /** Takes in the windows a response reported. */
    observe(burst: RateWindow, sustained: RateWindow) {
        if (isNum(burst.limit) && burst.limit > 0) this.burstLimit = burst.limit;
        if (isNum(sustained.remaining)) {
            // Only tightened within one daily window (a late response can't loosen it); a new reset is a new window.
            const newWindow = isNum(sustained.reset) && sustained.reset !== this.sustained.reset;
            if (newWindow || !isNum(this.sustained.remaining) || sustained.remaining < this.sustained.remaining) {
                this.sustained = {
                    limit: isNum(sustained.limit) ? sustained.limit : this.sustained.limit,
                    remaining: sustained.remaining,
                    reset: isNum(sustained.reset) ? sustained.reset : this.sustained.reset,
                };
            }
        }
    }

    /** A 429: nobody sends for `retryAfterS` (a full burst window when Metron sent none). */
    onRateLimited(retryAfterS: number, nowMs: number): number {
        const delay = retryAfterS > 0 ? retryAfterS * 1000 : BURST_PERIOD_MS;
        this.blockedUntil = Math.max(this.blockedUntil, nowMs + delay);
        return this.blockedUntil;
    }
}

const globalForMetron = globalThis as unknown as { __metronLimiter?: MetronLimiter };
function limiter(): MetronLimiter {
    if (!globalForMetron.__metronLimiter) globalForMetron.__metronLimiter = new MetronLimiter();
    return globalForMetron.__metronLimiter;
}
export function __resetMetronLimiterForTests() {
    globalForMetron.__metronLimiter = new MetronLimiter();
}

/**
 * Whether optional bulk work (the per-issue detail pass) should stop so normal syncing keeps room in
 * the account's daily window: under 10% (never under 500) of the limit left. Metron's own Sustained
 * headers decide when current; otherwise our rolling 24h count against the base limit.
 */
export function optionalBudgetSpent(sustained: RateWindow, nowMs: number, localCalls24h: number): boolean {
    if (isNum(sustained.reset) && sustained.reset * 1000 > nowMs && isNum(sustained.limit) && isNum(sustained.remaining)) {
        return sustained.remaining < Math.max(500, Math.floor(sustained.limit / 10));
    }
    return localCalls24h + BASE_DAILY_LIMIT / 10 >= BASE_DAILY_LIMIT;
}

/** Retry delay for a 5xx / network failure: 1 s, 2 s, 4 s … capped at 60 s. */
export function backoffMs(attempt: number): number {
    return Math.min(60_000, 1000 * 2 ** attempt);
}

/** Usage-counter key, folded exactly like the engine's api_usage::endpoint_key. */
export function endpointKey(url: string): string {
    let path = url.split('#')[0].split('?')[0];
    const scheme = path.indexOf('://');
    if (scheme >= 0) {
        const slash = path.indexOf('/', scheme + 3);
        path = slash >= 0 ? path.slice(slash) : '/';
    }
    const segments: string[] = [];
    for (const seg of path.split('/').filter(Boolean)) {
        if (seg === 'api' && segments.length === 0) continue;
        segments.push(/^[0-9-]+$/.test(seg) ? '{id}' : seg);
    }
    return segments.length ? `/${segments.join('/')}` : '/';
}

export async function readRateStatus(): Promise<RateStatus> {
    try {
        const row = await prisma.systemSetting.findUnique({ where: { key: METRON_RATE_STATUS_KEY } });
        if (row?.value) {
            const parsed = JSON.parse(row.value);
            return { ...parsed, burst: parsed?.burst ?? {}, sustained: parsed?.sustained ?? {} };
        }
    } catch { /* malformed → no shared state */ }
    return { burst: {}, sustained: {} };
}

const hasAny = (w: RateWindow) => isNum(w.limit) || isNum(w.remaining) || isNum(w.reset);

/** Folds a response's windows (and a 429's block) into the shared state the engine also writes. */
async function recordRateStatus(burst: RateWindow, sustained: RateWindow, blockedUntil?: number) {
    try {
        const status = await readRateStatus();
        const now = Date.now();
        if (hasAny(burst)) status.burst = burst;
        if (hasAny(sustained)) status.sustained = sustained;
        if (blockedUntil !== undefined) {
            const current = isNum(status.blockedUntil) && status.blockedUntil > now ? status.blockedUntil : 0;
            status.blockedUntil = Math.max(current, blockedUntil);
        }
        status.updatedAt = now;
        const value = JSON.stringify(status);
        await prisma.systemSetting.upsert({
            where: { key: METRON_RATE_STATUS_KEY },
            update: { value },
            create: { key: METRON_RATE_STATUS_KEY, value },
        });
    } catch { /* the shared state is best-effort */ }
}

// ------------------------------------------------------------------ requests

/** Metron refused to serve us right now (a long 429, or the daily limit): stop the work. */
export class MetronRateLimitError extends Error {
    readonly fatal = true;
    constructor(message: string, readonly retryAfterS: number) {
        super(`FATAL_RATE_LIMIT: ${message}`);
        this.name = 'MetronRateLimitError';
    }
}

/** A Metron HTTP failure (a 4xx is never retried; a 5xx only after the retries ran out). */
export class MetronHttpError extends Error {
    constructor(readonly status: number, message?: string) {
        super(message ?? `Metron HTTP Error: ${status}`);
        this.name = 'MetronHttpError';
    }
}

/** An optional request was skipped because no slot was free right now (see `optional`). */
export class MetronBusyError extends Error {
    constructor(readonly waitMs: number) {
        super(`Metron is busy for another ${Math.ceil(waitMs / 1000)}s; optional request skipped`);
        this.name = 'MetronBusyError';
    }
}

export class MetronCredentialsMissingError extends Error {
    constructor() {
        super('Metron credentials missing: add an API token (or a username and password) in Settings.');
        this.name = 'MetronCredentialsMissingError';
    }
}

export interface MetronGetOptions {
    /** Explicit credentials (e.g. the settings "Test" button); defaults to the configured ones. */
    auth?: MetronAuth | null;
    /** Conditional request for a detail endpoint; bypasses the response cache. */
    ifModifiedSince?: string;
    /** Use the shared MetadataCache (metadata_cache_enabled). Default true. */
    cache?: boolean;
    /** 'interactive' when someone is waiting on the page; default 'background'. */
    pace?: MetronPace;
    /**
     * A nice-to-have (e.g. a search result's cover): when no slot is free right now, throw
     * MetronBusyError at once instead of waiting - a page never hangs on an extra.
     */
    optional?: boolean;
    timeoutMs?: number;
    maxAttempts?: number;
}

export interface MetronResponse<T = any> {
    status: number;
    data: T;
    cached: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GETs a Metron API URL through the shared limiter. Resolves with 2xx, 304 (data null) and 404 bodies;
 * throws MetronRateLimitError (message contains FATAL_RATE_LIMIT) when the work must stop,
 * MetronHttpError for other failures, MetronCredentialsMissingError when nothing is configured.
 */
export async function metronGet<T = any>(url: string, opts: MetronGetOptions = {}): Promise<MetronResponse<T>> {
    const auth = opts.auth ?? await getMetronAuth();
    if (!auth) throw new MetronCredentialsMissingError();

    // Conditional requests bypass the cache - their whole point is asking Metron "did this change".
    const useCache = opts.cache !== false && !opts.ifModifiedSince;
    if (useCache) {
        const hit = await getCachedResponse('metron', url);
        if (hit !== null) return { status: 200, data: hit as T, cached: true };
    }

    const pace = opts.pace ?? 'background';
    const attempts = Math.max(1, opts.maxAttempts ?? 3);
    let lastErr: unknown = new Error('Metron max retries reached');

    for (let attempt = 0; attempt < attempts; attempt++) {
        // Wait for a slot; a wait longer than Metron's inline limit is a block - stop instead.
        for (;;) {
            const shared = await readRateStatus();
            const now = Date.now();
            const wait = limiter().waitMs(now, pace, shared);
            if (typeof wait === 'object') {
                throw new MetronRateLimitError(`Metron's daily request limit is used up; it resets in ${wait.dailyLimitRetryAfterS}s`, wait.dailyLimitRetryAfterS);
            }
            if (wait === 0) { limiter().recordSend(now); break; }
            if (opts.optional) throw new MetronBusyError(wait);
            if (wait > MAX_INLINE_WAIT_S * 1000) {
                const s = Math.ceil(wait / 1000);
                throw new MetronRateLimitError(`Metron has asked us to wait another ${s}s`, s);
            }
            await sleep(wait);
        }

        const headers: Record<string, string> = {
            Authorization: authHeader(auth),
            'User-Agent': METRON_USER_AGENT,
            Accept: 'application/json',
        };
        if (opts.ifModifiedSince) headers['If-Modified-Since'] = opts.ifModifiedSince;

        let response: Response;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
        try {
            response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        } catch (e) {
            lastErr = e;
            Logger.log(`[Metron] Attempt ${attempt + 1}/${attempts} failed to connect: ${e instanceof Error ? e.message : String(e)}`, 'debug');
            if (attempt + 1 < attempts) await sleep(backoffMs(attempt));
            continue;
        } finally {
            clearTimeout(timer);
        }

        // Every response is a request against the account's daily window.
        await logApiUsage('metron', endpointKey(url));
        const { burst, sustained } = parseRateHeaders(response.headers);
        limiter().observe(burst, sustained);

        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10) || 0;
            const effective = retryAfter > 0 ? retryAfter : BURST_PERIOD_MS / 1000;
            const until = limiter().onRateLimited(retryAfter, Date.now());
            await recordRateStatus(burst, sustained, until);
            if (effective > MAX_INLINE_WAIT_S) {
                await markSystemFlag('metron_rate_limit_time');
                Logger.log(`[Metron] Rate limited: Metron asked us to wait ${effective}s. Stopping this work.`, 'error');
                throw new MetronRateLimitError(`Metron asked us to wait ${effective}s`, effective);
            }
            Logger.log(`[Metron] Rate limited: waiting ${effective}s before retrying.`, 'warn');
            lastErr = new MetronHttpError(429, 'Metron HTTP 429 (rate limited)');
            continue; // the next slot is after the block
        }
        await recordRateStatus(burst, sustained);

        if (response.status >= 500) {
            lastErr = new MetronHttpError(response.status);
            if (attempt + 1 < attempts) await sleep(backoffMs(attempt));
            continue;
        }
        const ok = (response.status >= 200 && response.status < 300) || response.status === 304 || response.status === 404;
        if (!ok) throw new MetronHttpError(response.status, `Metron HTTP Error: ${response.status} (not retried)`);
        if (response.status === 204 || response.status === 304) return { status: response.status, data: null as T, cached: false };

        let data: T;
        try {
            data = await response.json();
        } catch {
            // A truncated body must never overwrite good data - retried like a server error.
            lastErr = new Error(`Metron returned an unparseable body for ${endpointKey(url)}`);
            if (attempt + 1 < attempts) await sleep(backoffMs(attempt));
            continue;
        }
        if (useCache && response.status === 200 && data && typeof data === 'object' && Object.keys(data as object).length > 0) {
            await putCachedResponse('metron', url, data);
        }
        return { status: response.status, data, cached: false };
    }
    throw lastErr;
}

/** Whether optional bulk work should stop (see optionalBudgetSpent), from the shared state + our counter. */
export async function metronOptionalBudgetExhausted(localCalls24h: number): Promise<boolean> {
    const status = await readRateStatus();
    return optionalBudgetSpent(status.sustained, Date.now(), localCalls24h);
}
