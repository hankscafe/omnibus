"use client"
// The System Health modal's Metron row: the account's real limits - supporter tier, daily window,
// per-minute burst limit - from the state the Node app and the engine share, re-read every 30 seconds
// while the modal is open, with live countdowns to the day's reset and to the end of a pause. It starts
// from the last health run's snapshot and keeps that if the live read fails.
import { useEffect, useState, type ReactNode } from "react"
import { CheckCircle2, AlertTriangle, XCircle, Clock } from "lucide-react"
import { metronLimitsView, formatCountdown, type MetronSnapshot, type MetronAlert } from "@/lib/metron/health"

const REFRESH_MS = 30_000;
const fmt = (n: number) => n.toLocaleString('en-US');

type Status = 'ok' | 'warning' | 'error';
type Props = { check: { id: string; name: string; status: Status; message: string; metron?: MetronSnapshot } };

const HEADLINE: Record<Status, string> = {
    ok: "Within Metron's limits",
    warning: "Close to Metron's daily limit",
    error: "Metron is limiting Omnibus right now",
};
const ICON: Record<Status, ReactNode> = {
    ok: <CheckCircle2 className="w-5 h-5 text-green-500" />,
    warning: <AlertTriangle className="w-5 h-5 text-amber-500" />,
    error: <XCircle className="w-5 h-5 text-red-500" />,
};
const TEXT: Record<Status, string> = {
    ok: 'text-muted-foreground',
    warning: 'text-amber-600 dark:text-amber-400 font-medium',
    error: 'text-red-500 font-medium',
};
const ALERT: Record<MetronAlert['level'], string> = {
    error: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    info: 'border-border bg-muted/40 text-muted-foreground',
};

export function MetronLimitsRow({ check }: Props) {
    const [snapshot, setSnapshot] = useState<MetronSnapshot | null>(check.metron ?? null);
    // The server's clock minus ours (from the live read): Metron's reset times are absolute, so the
    // countdowns follow the server's clock rather than a browser clock that may be off.
    const [offsetMs, setOffsetMs] = useState(0);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const res = await fetch('/api/admin/metron-status', { cache: 'no-store' });
                if (!res.ok) return;
                const body = await res.json();
                if (!alive || !body?.status) return;
                setSnapshot(body);
                if (typeof body.nowMs === 'number') setOffsetMs(body.nowMs - Date.now());
            } catch { /* keep the last snapshot */ }
        };
        load();
        const refresh = setInterval(load, REFRESH_MS);
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { alive = false; clearInterval(refresh); clearInterval(tick); };
    }, []);

    // A health run from before the snapshot existed: the plain line, as every other check shows.
    if (!snapshot) {
        return (
            <div data-status={check.status} className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30">
                <div className="shrink-0 mt-0.5">{ICON[check.status]}</div>
                <div className="flex-1 min-w-0">
                    <h4 className="font-bold text-sm text-foreground">{check.name}</h4>
                    <p className={`text-xs mt-0.5 ${TEXT[check.status]}`}>{check.message}</p>
                </div>
            </div>
        );
    }

    const clock = now + offsetMs;
    const view = metronLimitsView(snapshot, clock);
    const status = view.health.status;
    const daily = view.daily;
    const bar = daily && daily.remaining <= 0 ? 'bg-red-500' : daily && daily.remaining < daily.limit * 0.2 ? 'bg-amber-500' : 'bg-primary';

    return (
        <div data-status={status} className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30">
            <div className="shrink-0 mt-0.5">{ICON[status]}</div>
            <div className="flex-1 min-w-0 space-y-2">
                <div>
                    <h4 className="font-bold text-sm text-foreground">{check.name}</h4>
                    <p className={`text-xs mt-0.5 ${TEXT[status]}`}>{HEADLINE[status]}</p>
                </div>

                {view.alerts.map((a, i) => (
                    <div key={i} role={a.level === 'info' ? 'status' : 'alert'} className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-[11px] font-medium ${ALERT[a.level]}`}>
                        <span>{a.text}</span>
                        {a.untilMs ? (
                            <span className="shrink-0 flex items-center gap-1 font-mono tabular-nums"><Clock className="w-3 h-3" />{formatCountdown(a.untilMs - clock)}</span>
                        ) : null}
                    </div>
                ))}

                {daily ? (
                    <div className="space-y-1 bg-background/50 p-2 rounded border border-border/50 text-[11px] text-muted-foreground">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-foreground">{`${daily.tier.label} · ${fmt(daily.limit)} per day`}</span>
                            {daily.resetAtMs !== null && (
                                <span className="flex items-center gap-1">resets in <span className="font-mono tabular-nums">{formatCountdown(daily.resetAtMs - clock)}</span></span>
                            )}
                        </div>
                        <div className="h-1.5 rounded bg-muted overflow-hidden" role="progressbar" aria-label="Metron requests used today" aria-valuemin={0} aria-valuemax={daily.limit} aria-valuenow={daily.used}>
                            <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, (daily.used / daily.limit) * 100)}%` }} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                            <span>{`${fmt(daily.remaining)} of ${fmt(daily.limit)} left`}</span>
                            {!daily.current && <span>a new day since Metron last reported</span>}
                        </div>
                        {!daily.tier.supporter && (
                            <p>Metron raises the daily limit for supporters (7,500 to 25,000 a day); Omnibus picks up a raised limit from Metron automatically.</p>
                        )}
                    </div>
                ) : (
                    <p className="text-[11px] text-muted-foreground">{`${fmt(view.localCalls24h)} Metron requests in the last 24 hours (Omnibus's own count)`}</p>
                )}

                {view.burst && (
                    <p className="text-[11px] text-muted-foreground">
                        {`Burst limit: ${view.burst.limit} per minute`}
                        {view.burst.remaining !== null ? ` (${view.burst.remaining} left this minute)` : ''}
                        {' - set by Metron, and it changes with their server load.'}
                    </p>
                )}

                {view.reportedAtMs !== null && (
                    <p className="text-[10px] text-muted-foreground/80">{`As of ${new Date(view.reportedAtMs).toLocaleTimeString()}: Metron reports these limits with every response.`}</p>
                )}
            </div>
        </div>
    );
}
