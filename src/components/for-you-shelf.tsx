"use client";
// Library-aware recommendations, Beta C (field report by robotshavehearts2: "look at my library as
// a whole and surface what I don't have"). The engine's FOR_YOU_SYNC ranks series the library
// lacks from its own credits ledger (Beta A/B); this file is the front-page shelf, the card both
// surfaces share, and the two actions on a card:
//   Monitor — the same monitor-only request the reading-list auto-build files: the series gets a
//             row, a metadata sync, and a follow; its issues then appear in Missing Issues with
//             Request on each (beta.013), so the loop closes without a download being forced.
//   Not interested — a per-user dismissal (the shelf is library-level, the dismissal is personal),
//             undoable from the toast.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Sparkles, Image as ImageIcon, Eye, EyeOff, Loader2, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";

export interface ForYouBecause { kind: 'PERSON' | 'CHARACTER'; id: string; name: string }
export interface ForYouItem {
  volumeId: string;
  name: string;
  startYear: number | null;
  publisher: string;
  image: string | null;
  countOfIssues: number;
  description: string | null;
  siteUrl: string | null;
  score: number;
  because: ForYouBecause[];
  metadataSource: string;
}
export interface ForYouSeed { kind: 'PERSON' | 'CHARACTER'; id: string; name: string; weight: number; series: number; role: string }
export interface ForYouResponse {
  builtAt: string | null;
  reason?: string | null;
  seeds: ForYouSeed[];
  items: ForYouItem[];
  total: number;
  nextOffset: number | null;
}

/** "Scott Snyder, Superman +2" — the first `max` reasons by name, the rest as a count. */
export function becauseLabel(because: ForYouBecause[], max = 2): string {
  if (!because || because.length === 0) return "";
  const head = because.slice(0, max).map(b => b.name).join(", ");
  const rest = because.length - max;
  return rest > 0 ? `${head} +${rest}` : head;
}

/** The headline seeds, kinds interleaved so a person and a character both show: [P1, C1, P2, ...]. */
export function seedHeadline(seeds: ForYouSeed[], n = 3): string[] {
  const people = seeds.filter(s => s.kind === 'PERSON');
  const chars = seeds.filter(s => s.kind === 'CHARACTER');
  const out: string[] = [];
  for (let i = 0; out.length < n && (i < people.length || i < chars.length); i++) {
    if (people[i]) out.push(people[i].name);
    if (out.length < n && chars[i]) out.push(chars[i].name);
  }
  return out;
}

/** Joins names as prose: "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The monitor-only request the reading-list auto-build files (same route, same permissions, same
 * manga gate, same audit): a Series row + metadata sync + follow, no download forced.
 */
export async function monitorSeries(item: ForYouItem): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cvId: parseInt(item.volumeId, 10) || item.volumeId,
        name: item.name,
        type: 'volume',
        year: item.startYear ? String(item.startYear) : undefined,
        publisher: item.publisher || 'Unknown',
        image: item.image,
        metadataSource: item.metadataSource || 'COMICVINE',
        monitorOnly: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, message: data.message };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

/** Per-user "not interested" (undo = true removes it). */
export async function dismissRecommendation(item: ForYouItem, undo = false): Promise<boolean> {
  try {
    const res = await fetch('/api/recommendations/for-you/dismiss', {
      method: undo ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volumeId: item.volumeId, source: item.metadataSource || 'COMICVINE' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Shared card-action state: removes a card on Monitor / Not interested, with the toasts both
 * surfaces want (Not interested gets an Undo that puts the card back).
 */
export function useForYouActions(
  setItems: (fn: (prev: ForYouItem[]) => ForYouItem[]) => void,
  onCountChange?: (delta: number) => void,
) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const mark = (id: string, on: boolean) => setBusy(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });

  const monitor = async (item: ForYouItem) => {
    mark(item.volumeId, true);
    const r = await monitorSeries(item);
    mark(item.volumeId, false);
    if (r.ok) {
      setItems(prev => prev.filter(i => i.volumeId !== item.volumeId));
      onCountChange?.(-1);
      toast({ title: `Monitoring ${item.name}`, description: r.message || "Its issues will show up under Missing Issues, ready to request." });
    } else {
      toast({ title: "Couldn't monitor that series", description: r.error, variant: "destructive" });
    }
  };

  const dismiss = async (item: ForYouItem) => {
    mark(item.volumeId, true);
    const ok = await dismissRecommendation(item);
    mark(item.volumeId, false);
    if (!ok) {
      toast({ title: "Couldn't save that", description: "The dismissal didn't stick. Try again.", variant: "destructive" });
      return;
    }
    // Remember where the card sat so Undo puts it back in place, not at the front.
    let index = 0;
    setItems(prev => { index = Math.max(0, prev.findIndex(i => i.volumeId === item.volumeId)); return prev.filter(i => i.volumeId !== item.volumeId); });
    onCountChange?.(-1);
    toast({
      title: "Hidden from your recommendations",
      description: item.name,
      action: (
        <ToastAction altText="Undo hiding this series" onClick={async () => {
          if (!(await dismissRecommendation(item, true))) return;
          setItems(prev => {
            if (prev.some(i => i.volumeId === item.volumeId)) return prev;
            const next = prev.slice();
            next.splice(Math.min(index, next.length), 0, item);
            return next;
          });
          onCountChange?.(1);
        }}>Undo</ToastAction>
      ),
    });
  };

  return { busy, monitor, dismiss };
}

interface CardProps {
  item: ForYouItem;
  layout: 'shelf' | 'grid';
  canRequest: boolean;
  busy: boolean;
  onMonitor: (item: ForYouItem) => void;
  onDismiss: (item: ForYouItem) => void;
}

/** One recommendation. 'shelf' = hover overlay like the sibling shelves; 'grid' = reason + actions beneath the cover (touch-friendly). */
export function ForYouCard({ item, layout, canRequest, busy, onMonitor, onDismiss }: CardProps) {
  const reason = becauseLabel(item.because, layout === 'grid' ? 3 : 2);
  const cover = (
    <div className="relative aspect-[2/3] bg-muted rounded-lg overflow-hidden border border-border">
      {item.image ? (
        <img src={item.image} alt={item.name} className="object-cover w-full h-full" loading="lazy" />
      ) : (
        <div className="w-full h-full flex items-center justify-center"><ImageIcon className="w-8 h-8 text-muted-foreground/50" /></div>
      )}
      {layout === 'shelf' && (
        <>
          <div className="absolute bottom-0 left-0 w-full p-3 bg-linear-to-t from-black/90 via-black/60 to-transparent z-10 group-hover:opacity-0 transition-opacity duration-200 ease-out pointer-events-none">
            <p className="text-white font-bold text-xs truncate drop-shadow-md">{item.name}</p>
            <p className="text-white/80 text-[10px] font-medium drop-shadow-md mt-0.5 truncate">Because you collect {reason}</p>
          </div>
          <div className="absolute inset-0 bg-linear-to-t from-black/95 via-black/70 to-black/30 opacity-0 group-hover:opacity-100 transition-opacity duration-200 ease-out hidden sm:flex flex-col justify-end p-3 text-center gap-1.5 z-20">
            <h3 className="text-white font-bold text-sm line-clamp-2 drop-shadow-md">{item.name}</h3>
            <p className="text-white/80 text-[11px] drop-shadow-md">{item.startYear || '????'} · {item.publisher} · {item.countOfIssues} {item.countOfIssues === 1 ? 'issue' : 'issues'}</p>
            <p className="text-white/90 text-[11px] drop-shadow-md line-clamp-2">Because you collect {reason}</p>
            {canRequest && (
              <Button size="sm" aria-label={`Monitor ${item.name}`} disabled={busy} onClick={(e) => { e.stopPropagation(); onMonitor(item); }}
                className="w-full min-w-0 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md border-0 mt-1">
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Eye className="w-3 h-3 shrink-0 mr-1" /> Monitor</>}
              </Button>
            )}
            <Button size="sm" variant="ghost" aria-label={`Not interested in ${item.name}`} disabled={busy} onClick={(e) => { e.stopPropagation(); onDismiss(item); }}
              className="w-full min-w-0 text-white/80 hover:text-white hover:bg-white/10 h-7 text-xs">
              <EyeOff className="w-3 h-3 shrink-0 mr-1" /> Not interested
            </Button>
          </div>
        </>
      )}
    </div>
  );

  if (layout === 'shelf') {
    return <div className="group relative flex-none w-[calc(50%-0.5rem)] md:w-[calc(25%-0.75rem)] lg:w-[calc(14.285%-0.857rem)] snap-start hover:scale-[1.03] transition-transform duration-200">{cover}</div>;
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`for-you-card-${item.volumeId}`}>
      {cover}
      <div className="min-w-0">
        <p className="font-bold text-sm text-foreground truncate" title={item.name}>{item.name}</p>
        <p className="text-xs text-muted-foreground truncate">{item.startYear || '????'} · {item.publisher} · {item.countOfIssues} {item.countOfIssues === 1 ? 'issue' : 'issues'}</p>
        <p className="text-xs text-primary/90 mt-1 line-clamp-2"><Sparkles className="w-3 h-3 inline-block mr-1 -mt-0.5" />Because you collect {reason}</p>
      </div>
      {/* Stacked, each full width: side by side they need ~205px, and a grid card is 146-225px. */}
      <div className="flex flex-col gap-1.5">
        {canRequest && (
          <Button size="sm" aria-label={`Monitor ${item.name}`} disabled={busy} onClick={() => onMonitor(item)}
            className="w-full h-8 text-[11px] font-black uppercase tracking-wider">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Eye className="w-3.5 h-3.5 mr-1" /> Monitor</>}
          </Button>
        )}
        <Button size="sm" variant="outline" aria-label={`Not interested in ${item.name}`} disabled={busy} onClick={() => onDismiss(item)}
          className="w-full h-8 text-[11px] font-bold border-border text-muted-foreground hover:text-foreground px-2">
          <EyeOff className="w-3.5 h-3.5 mr-1" /> Not interested
        </Button>
      </div>
    </div>
  );
}

/** Rotates a window of `size` cards through the ranked list once a day, so the shelf changes without the rebuild changing. */
export function dailyWindow<T>(items: T[], size: number, dayBucket = Math.floor(Date.now() / 86_400_000)): T[] {
  if (items.length <= size) return items;
  const start = (dayBucket * size) % items.length;
  const out = items.slice(start, start + size);
  return out.length < size ? out.concat(items.slice(0, size - out.length)) : out;
}

const SHELF_SIZE = 7;

export function ForYouShelf({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const canRequest = isAdmin || !!session?.user?.canRequest;
  const [items, setItems] = useState<ForYouItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { busy, monitor, dismiss } = useForYouActions(setItems);

  useEffect(() => {
    let alive = true;
    fetch(`/api/recommendations/for-you?limit=${SHELF_SIZE * 3}&_t=${Date.now()}`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then((data: ForYouResponse | null) => {
        if (!alive || !data) return;
        setItems(Array.isArray(data.items) ? data.items : []);
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refreshSignal]);

  const shown = useMemo(() => dailyWindow(items, SHELF_SIZE), [items]);

  // Nothing built yet, or nothing left to show: the shelf stays out of the way (the page explains).
  if (loading || shown.length === 0) return null;

  // Header and See All mirror Recently Added / Jump Back In exactly: bare h2, the outlined primary
  // link on desktop, the same link full-width beneath the row on mobile.
  return (
    <div className="space-y-4 pt-4" aria-label="For your library">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">For Your Library</h2>
        <Button asChild variant="outline" size="sm" className="border-primary/50 text-primary hover:bg-primary/10 group font-bold hidden sm:flex">
          <Link href="/library/for-you" aria-label="See every recommendation for your library">
            <span>See All</span> <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </Button>
      </div>
      <div className="flex overflow-x-auto gap-4 pb-6 pt-4 px-2 snap-x no-scrollbar -mx-2">
        {shown.map(item => (
          <ForYouCard key={item.volumeId} item={item} layout="shelf" canRequest={canRequest} busy={busy.has(item.volumeId)} onMonitor={monitor} onDismiss={dismiss} />
        ))}
      </div>
      <div className="sm:hidden pt-2">
        <Button asChild variant="outline" className="w-full border-primary/50 text-primary hover:bg-primary/10 group font-bold">
          <Link href="/library/for-you" aria-label="See every recommendation for your library">
            <span>See All</span> <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** Small receipt used by the page after a Monitor: the series now lives in the library. */
export function MonitoredReceipt({ name }: { name: string }) {
  return <span className="inline-flex items-center text-xs text-muted-foreground"><Check className="w-3 h-3 mr-1" /> Monitoring {name}</span>;
}
