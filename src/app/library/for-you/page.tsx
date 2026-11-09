"use client";
// /library/for-you — every recommendation the library's credits produced (Beta C). The engine
// builds the ranked list on the Discover cadence; this page reads the cache, shows WHY each series
// is here, and offers the two actions: Monitor (a series row + sync + follow — its issues then sit
// in Missing Issues with Request on each) and Not interested (per user, undoable).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ChevronLeft, Sparkles, Loader2, RefreshCw, Users, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { ForYouCard, useForYouActions, type ForYouItem, type ForYouSeed, type ForYouResponse } from "@/components/for-you-shelf";

const PAGE_SIZE = 24;

export default function ForYouPage() {
  const { data: session } = useSession();
  const { toast } = useToast();
  const isAdmin = session?.user?.role === 'ADMIN';
  const canRequest = isAdmin || !!session?.user?.canRequest;

  const [items, setItems] = useState<ForYouItem[]>([]);
  const [seeds, setSeeds] = useState<ForYouSeed[]>([]);
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [building, setBuilding] = useState(false);
  const { busy, monitor, dismiss } = useForYouActions(setItems, (delta) => setTotal(t => Math.max(0, t + delta)));

  const load = useCallback(async (offset: number) => {
    const res = await fetch(`/api/recommendations/for-you?limit=${PAGE_SIZE}&offset=${offset}&_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ForYouResponse;
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load(0).then(data => {
      if (!alive) return;
      setItems(data.items || []);
      setSeeds(data.seeds || []);
      setBuiltAt(data.builtAt || null);
      setReason(data.reason || null);
      setTotal(data.total || 0);
      setNextOffset(data.nextOffset ?? null);
    }).catch(() => { if (alive) toast({ title: "Couldn't load recommendations", variant: "destructive" }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load, toast]);

  const loadMore = async () => {
    if (nextOffset === null) return;
    setLoadingMore(true);
    try {
      const data = await load(nextOffset);
      setItems(prev => {
        const seen = new Set(prev.map(i => i.volumeId));
        return prev.concat((data.items || []).filter(i => !seen.has(i.volumeId)));
      });
      setNextOffset(data.nextOffset ?? null);
    } catch {
      toast({ title: "Couldn't load more", variant: "destructive" });
    } finally {
      setLoadingMore(false);
    }
  };

  // Admin-only: kick the engine's rebuild now instead of waiting for the Discover cadence.
  const buildNow = async () => {
    setBuilding(true);
    try {
      const res = await fetch('/api/admin/jobs/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: 'for_you' }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Building recommendations", description: "The engine is ranking your library against ComicVine. Reload in a minute." });
    } catch {
      toast({ title: "Couldn't start the build", variant: "destructive" });
    } finally {
      setBuilding(false);
    }
  };

  const people = useMemo(() => seeds.filter(s => s.kind === 'PERSON'), [seeds]);
  const characters = useMemo(() => seeds.filter(s => s.kind === 'CHARACTER'), [seeds]);
  const built = builtAt ? new Date(builtAt) : null;

  return (
    <div className="container mx-auto px-4 py-8 space-y-8 max-w-7xl">
      <div className="space-y-2">
        <Link href="/library" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ChevronLeft className="w-4 h-4" /> Library
        </Link>
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
          <Sparkles className="w-7 h-7 text-primary" /> For Your Library
        </h1>
        <p className="text-muted-foreground max-w-3xl">
          Series you don&apos;t have, ranked from what you do: the writers, artists and characters across your whole library.
          {built && !isNaN(built.getTime()) && <span className="block text-xs mt-1">Built {built.toLocaleString()}. Rebuilds with the Discover sync.</span>}
        </p>
      </div>

      {seeds.length > 0 && (
        <div className="space-y-2" aria-label="What these are based on">
          {people.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1 mr-1"><User className="w-3.5 h-3.5" /> Creators</span>
              {people.map(s => <Badge key={`p-${s.id}`} variant="secondary" className="font-medium" title={`On ${s.series} of your series`}>{s.name}</Badge>)}
            </div>
          )}
          {characters.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1 mr-1"><Users className="w-3.5 h-3.5" /> Characters</span>
              {characters.map(s => <Badge key={`c-${s.id}`} variant="outline" className="font-medium" title={`In ${s.series} of your series`}>{s.name}</Badge>)}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 space-y-3 border border-dashed border-border rounded-xl">
          <Sparkles className="w-10 h-10 mx-auto text-muted-foreground/50" />
          {!builtAt ? (
            <>
              <p className="font-bold text-foreground">Nothing built yet</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">Recommendations are built from your library&apos;s credits on the Discover sync schedule. {isAdmin ? 'You can start one now.' : 'Check back after the next sync.'}</p>
            </>
          ) : reason === 'no_credits' ? (
            <>
              <p className="font-bold text-foreground">Your series need a metadata sync first</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">The credits every recommendation rests on arrive with each series&apos; provider sync. Once a sync has run, the next build has something to work with.</p>
            </>
          ) : reason === 'no_seeds' ? (
            <>
              <p className="font-bold text-foreground">Not enough to go on yet</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">Creators only count once your library knows their role — open a few issues or tag your files — and characters need synced series. The next build will try again.</p>
            </>
          ) : (
            <>
              <p className="font-bold text-foreground">Nothing new right now</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">Everything from the last build is in your library, requested, or hidden. The next sync brings a fresh list.</p>
            </>
          )}
          {isAdmin && (
            <Button variant="outline" onClick={buildNow} disabled={building} aria-label="Build recommendations now" className="mt-2">
              {building ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />} Build now
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{total} {total === 1 ? 'series' : 'series'} · {canRequest ? 'Monitor adds a series to your library and lists its issues under Missing Issues.' : 'Ask an admin for the Request permission to monitor a series from here.'}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-5">
            {items.map(item => (
              <ForYouCard key={item.volumeId} item={item} layout="grid" canRequest={canRequest} busy={busy.has(item.volumeId)} onMonitor={monitor} onDismiss={dismiss} />
            ))}
          </div>
          {nextOffset !== null && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore} aria-label="Load more recommendations">
                {loadingMore ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
