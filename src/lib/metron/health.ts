// Metron's limits as the System Health check and the Health modal show them - client-safe (no Prisma),
// so the modal can count down live from the same state the health check read.
//
// Metron reports the account's limits on every response: X-RateLimit-Burst-* per minute (it varies with
// server load) and X-RateLimit-Sustained-* per day (set by the account's supporter tier: 5,000 standard,
// raised to 7,500 / 10,000 / 15,000 / 25,000 for supporters). Both processes keep the latest in
// SystemSetting `metron_rate_status`, along with any pause a 429 asked for.

/** One rate-limit window as Metron reports it; `reset` is a Unix epoch in seconds. */
export type RateWindow = { limit?: number | null; remaining?: number | null; reset?: number | null };
/** The state both processes share (SystemSetting `metron_rate_status`); times in epoch ms. */
export type RateStatus = { burst: RateWindow; sustained: RateWindow; blockedUntil?: number | null; updatedAt?: number | null };
/** What the Health modal works from: the shared state, our own 24h count, and when a long 429 last hit. */
export type MetronSnapshot = { status: RateStatus; localCalls24h: number; rateLimitFlagMs: number; nowMs?: number };

/** Metron's standard daily limit - only a fallback until Metron reports the account's real one. */
export const BASE_DAILY_LIMIT = 5_000;
/** How long a long 429 keeps the health line red. */
const RATE_LIMIT_FLAG_MS = 60 * 60 * 1000;

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The account's tier, from the daily limit Metron reports: anything above the standard 5,000 is a supporter's. */
export function metronTier(dailyLimit: number): { supporter: boolean; label: 'Standard' | 'Supporter' } {
    return dailyLimit > BASE_DAILY_LIMIT ? { supporter: true, label: 'Supporter' } : { supporter: false, label: 'Standard' };
}

/** Our own Metron calls in the last 24 hours, from `metron_api_usage` ({ endpoint: [epoch ms, …] }). */
export function metronCalls24h(rawUsage: string | null | undefined, nowMs: number): number {
    if (!rawUsage) return 0;
    try {
        const usage = JSON.parse(rawUsage);
        let calls = 0;
        for (const ep in usage) {
            if (Array.isArray(usage[ep])) calls += usage[ep].filter((ts: unknown) => isNum(ts) && nowMs - ts < 86_400_000).length;
        }
        return calls;
    } catch {
        return 0;
    }
}

/** "3h 12m" / "12m" (rounded up to the minute) - for the health line, which is text frozen at check time. */
export function formatDuration(ms: number): string {
    const totalMin = Math.max(1, Math.ceil(ms / 60_000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** A live countdown: "3:12:05", or "1:05" under an hour; never negative. */
export function formatCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * The Health check's Metron line, from what Metron itself reported (the daily limit depends on the
 * supporter tier, the burst limit on server load), falling back to our own 24h count against the
 * standard limit when no window has been reported.
 */
export function describeMetronHealth(
    status: RateStatus, localCalls24h: number, rateLimitFlagMs: number, nowMs: number,
): { status: 'ok' | 'warning' | 'error'; message: string } {
    if (isNum(status.blockedUntil) && status.blockedUntil > nowMs) {
        return { status: 'error', message: `Metron has asked Omnibus to pause (rate limit). Requests resume in ${formatDuration(status.blockedUntil - nowMs)}.` };
    }
    const burstLimit = status.burst?.limit;
    const burst = isNum(burstLimit) && burstLimit > 0 ? ` Burst: ${burstLimit} per minute.` : '';
    const s = status.sustained ?? {};
    const current = isNum(s.reset) && s.reset * 1000 > nowMs && isNum(s.limit) && isNum(s.remaining);
    if (current) {
        const left = `${fmt(s.remaining!)} of ${fmt(s.limit!)} requests left today (${metronTier(s.limit!).label} limit; resets in ${formatDuration(s.reset! * 1000 - nowMs)})`;
        if (s.remaining! <= 0) return { status: 'error', message: `Daily limit reached. Syncing paused: ${left}.${burst}` };
        if (rateLimitFlagMs > nowMs - RATE_LIMIT_FLAG_MS) return { status: 'error', message: `Rate limit reached within the last hour. Syncing paused. ${left}.${burst}` };
        if (s.remaining! < s.limit! * 0.2) return { status: 'warning', message: `Approaching the daily limit: ${left}.${burst}` };
        return { status: 'ok', message: `Status: Normal. ${left}.${burst}` };
    }
    if (rateLimitFlagMs > nowMs - RATE_LIMIT_FLAG_MS) {
        return { status: 'error', message: `Rate limit reached. Syncing paused. Past 24 hours: ${localCalls24h} calls.` };
    }
    if (localCalls24h > BASE_DAILY_LIMIT * 0.8) {
        return { status: 'warning', message: `Approaching the daily limit. Past 24 hours: ${localCalls24h} / ${BASE_DAILY_LIMIT} calls.` };
    }
    return { status: 'ok', message: `Status: Normal. Past 24 hours: ${localCalls24h} / ${BASE_DAILY_LIMIT} calls.` };
}

export type MetronAlert = { level: 'error' | 'warning' | 'info'; text: string; untilMs?: number | null };

export type MetronLimitsView = {
    health: { status: 'ok' | 'warning' | 'error'; message: string };
    /** The day's window. `current` = its reset is still ahead; once it has passed, the day starts full. */
    daily: { limit: number; remaining: number; used: number; resetAtMs: number | null; tier: ReturnType<typeof metronTier>; current: boolean } | null;
    /** The per-minute window; remaining/reset only while that minute is still running. */
    burst: { limit: number; remaining: number | null; resetAtMs: number | null } | null;
    /** Most urgent first; `untilMs` is what a countdown counts to. */
    alerts: MetronAlert[];
    /** When Metron last reported (epoch ms). */
    reportedAtMs: number | null;
    localCalls24h: number;
};

/** Everything the Health modal's Metron row shows, at `nowMs`. */
export function metronLimitsView(snapshot: MetronSnapshot, nowMs: number): MetronLimitsView {
    const { status, localCalls24h, rateLimitFlagMs } = snapshot;
    const s = status.sustained ?? {};
    const b = status.burst ?? {};

    let daily: MetronLimitsView['daily'] = null;
    if (isNum(s.limit) && s.limit > 0) {
        const current = isNum(s.reset) && s.reset * 1000 > nowMs && isNum(s.remaining);
        const remaining = current ? Math.max(0, s.remaining!) : s.limit;
        daily = { limit: s.limit, remaining, used: s.limit - remaining, resetAtMs: current ? s.reset! * 1000 : null, tier: metronTier(s.limit), current };
    }

    let burst: MetronLimitsView['burst'] = null;
    if (isNum(b.limit) && b.limit > 0) {
        const current = isNum(b.reset) && b.reset * 1000 > nowMs && isNum(b.remaining);
        burst = { limit: b.limit, remaining: current ? b.remaining! : null, resetAtMs: current ? b.reset! * 1000 : null };
    }

    const alerts: MetronAlert[] = [];
    const paused = isNum(status.blockedUntil) && status.blockedUntil > nowMs;
    if (paused) {
        alerts.push({ level: 'error', text: 'Metron has paused Omnibus (rate limit): no Metron requests until the pause ends.', untilMs: status.blockedUntil });
    }
    if (daily?.current && daily.remaining <= 0) {
        alerts.push({ level: 'error', text: 'Daily limit reached: Metron syncing is paused until the day resets.', untilMs: daily.resetAtMs });
    } else if (rateLimitFlagMs > nowMs - RATE_LIMIT_FLAG_MS) {
        alerts.push({ level: 'error', text: 'Metron rate-limited Omnibus within the last hour; that job stopped instead of retrying.', untilMs: rateLimitFlagMs + RATE_LIMIT_FLAG_MS });
    } else if (daily?.current && daily.remaining < daily.limit * 0.2) {
        alerts.push({ level: 'warning', text: 'Approaching the daily limit.', untilMs: daily.resetAtMs });
    }
    if (burst && burst.remaining !== null && burst.remaining <= 0) {
        alerts.push({ level: 'info', text: 'Per-minute limit used: requests wait for the next minute.', untilMs: burst.resetAtMs });
    }
    if (!daily && !burst && !paused) {
        alerts.push({ level: 'info', text: "Metron hasn't reported this account's limits yet; they appear after Omnibus's next Metron request." });
    }

    return {
        health: describeMetronHealth(status, localCalls24h, rateLimitFlagMs, nowMs),
        daily,
        burst,
        alerts,
        reportedAtMs: isNum(status.updatedAt) ? status.updatedAt : null,
        localCalls24h,
    };
}
