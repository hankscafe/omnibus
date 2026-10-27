// src/app/library/issues/page.tsx
"use client"

import { useState, useEffect, useCallback, useRef, Suspense } from "react"
import Link from "next/link"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useSession } from "next-auth/react"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { requestNameFor } from "@/lib/utils/request-name"
import { normalizeFractionNumbers } from "@/lib/utils/issue-parser"
import { filtersFromParams, paramsFromFilters, ISSUE_SORT_DEFAULT, type IssueFilters } from "@/lib/utils/issue-filters"
import { coveredByLabel, type CoveredBy } from "@/components/covered-issues-section"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Image as ImageIcon, Loader2, Search, SortAsc, Filter, Clock, X,
  CalendarDays, ChevronLeft, Library as LibraryIcon, BookCheck, DownloadCloud, Check, BookMarked
} from "lucide-react"

interface IssueRow {
  id: string;
  number: string;
  name: string | null;
  cover: string | null;
  releaseDate: string | null;
  onDisk: boolean;
  seriesName: string;
  seriesPath: string | null;
  publisher: string;
  year: number | null;
  // Requesting from this view (field report by robotshavehearts2): the series' provider identity
  // and the issue's domain, so the composite matches what the series page would file.
  isAnnual?: boolean;
  isCollected?: boolean;
  collectionName?: string | null;
  isSpecial?: boolean;
  specialName?: string | null;
  seriesMetadataId?: string | null;
  metadataSource?: string;
  requestable?: boolean;
  // #203 COLLECTED coverage: present when an OWNED collected edition reprints this issue (the API
  // only sends such rows when asked with includeCovered=1).
  coveredBy?: CoveredBy | null;
}

const DEFAULT_SORT = ISSUE_SORT_DEFAULT;

function IssuesSkeleton({ count = 24 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10" aria-hidden="true">
      {[...Array(count)].map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="aspect-[2/3] rounded-xl bg-muted animate-pulse" />
          <div className="h-3 w-3/4 bg-muted animate-pulse rounded" />
          <div className="h-2 w-1/2 bg-muted animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}

function LibraryIssuesInner() {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const canRequest = isAdmin || !!(session?.user as any)?.canRequest;
  const [requestingIds, setRequestingIds] = useState<Set<string>>(new Set());
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  // The URL is the filter state (issue-filters.ts). Read ONCE, at mount, into the initializers
  // below: /library/issues?status=WANTED is the "missing issues" entry point, and it has to land
  // already filtered rather than flash the whole library and then narrow.
  const searchParams = useSearchParams();
  const initialRef = useRef<IssueFilters | null>(null);
  if (initialRef.current === null) initialRef.current = filtersFromParams(searchParams);
  const initial = initialRef.current;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // The next page's cursor lives in a ref so the IntersectionObserver callback always reads the latest
  // value without being re-created on every page load.
  const cursorRef = useRef<string | null>(null);

  const [publishers, setPublishers] = useState<string[]>([]);
  // Both search states seed from the URL so the first fetch already carries `q` — otherwise the
  // 400ms debounce would fire a second, narrower load right after the first.
  const [searchQuery, setSearchQuery] = useState(initial.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initial.search);
  const [publisherFilter, setPublisherFilter] = useState(initial.publisher);
  const [eraFilter, setEraFilter] = useState(initial.era);
  const [libraryFilter, setLibraryFilter] = useState(initial.library);
  const [statusFilter, setStatusFilter] = useState<string>(initial.status);
  const [sortOption, setSortOption] = useState(initial.sort);
  // #203 COLLECTED coverage: issues an owned trade reprints are fetched WITH the page (so the
  // toggle's count is honest on first paint) and hidden client-side unless this is on — the same
  // shape as the matcher's "Show ignored". Not a fetch filter: flipping it never reloads.
  const [showCovered, setShowCovered] = useState(initial.covered);

  // Mirror filters into a ref so loadIssues (a stable useCallback) reads current values without deps churn.
  const filtersRef = useRef<IssueFilters>({ ...initial });
  useEffect(() => {
    filtersRef.current = { search: debouncedSearch, publisher: publisherFilter, era: eraFilter, library: libraryFilter, status: statusFilter as IssueFilters["status"], sort: sortOption, covered: showCovered };
  }, [debouncedSearch, publisherFilter, eraFilter, libraryFilter, statusFilter, sortOption, showCovered]);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const loadIssues = useCallback(async (reset: boolean) => {
    if (reset) { setLoading(true); cursorRef.current = null; }
    else setLoadingMore(true);

    const f = filtersRef.current;
    const params = new URLSearchParams();
    params.append('limit', '48');
    if (!reset && cursorRef.current) params.append('cursor', cursorRef.current);
    params.append('sort', f.sort);
    if (f.publisher !== 'ALL') params.append('publisher', f.publisher);
    if (f.era !== 'ALL') params.append('era', f.era);
    if (f.library !== 'ALL') params.append('library', f.library);
    if (f.status !== 'ALL') params.append('status', f.status);
    if (f.search.trim()) params.append('q', f.search.trim());
    // Covered rows ride along flagged (`coveredBy`); whether they SHOW is decided here, not there.
    params.append('includeCovered', '1');

    try {
      const res = await fetch(`/api/library/issues?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        toastRef.current({ title: "Error", description: data.error || "Failed to load issues.", variant: "destructive" });
        return;
      }
      setIssues(prev => {
        if (reset) return data.issues || [];
        const seen = new Set(prev.map((i: IssueRow) => i.id));
        return [...prev, ...(data.issues || []).filter((i: IssueRow) => !seen.has(i.id))];
      });
      cursorRef.current = data.nextCursor || null;
      setHasMore(!!data.hasMore);
      if (data.publishers) setPublishers(data.publishers);
    } catch {
      toastRef.current({ title: "Error", description: "Failed to load issues.", variant: "destructive" });
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const isFirstRender = useRef(true);
  useEffect(() => {
    loadIssues(true);
    const t = setTimeout(() => { isFirstRender.current = false; }, 100);
    return () => clearTimeout(t);
  }, [loadIssues]);

  // Any filter/sort change resets the cursor and reloads from the start.
  useEffect(() => {
    if (isFirstRender.current) return;
    window.scrollTo({ top: 0 });
    loadIssues(true);
  }, [debouncedSearch, publisherFilter, eraFilter, libraryFilter, statusFilter, sortOption, loadIssues]);

  // …and writes the URL, so the view a user builds is the view a shared link opens. `replace`, not
  // `push`: filter changes are not history entries. The URL is written only when it would CHANGE
  // — so a deep link doesn't rewrite itself on the seeding render, and (after the debounce)
  // typing doesn't rewrite per keystroke. Compared against the last write rather than a timer: a
  // toggle flipped the instant the page lands must still reach the URL.
  const lastWrittenQs = useRef(paramsFromFilters(initial));
  useEffect(() => {
    const qs = paramsFromFilters(filtersRef.current);
    if (qs === lastWrittenQs.current) return;
    lastWrittenQs.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [debouncedSearch, publisherFilter, eraFilter, libraryFilter, statusFilter, sortOption, showCovered, router, pathname]);

  const observer = useRef<IntersectionObserver | null>(null);
  const lastElementRef = useCallback((node: HTMLDivElement | null) => {
    if (loading || loadingMore) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) loadIssues(false);
    }, { rootMargin: "400px" });
    if (node) observer.current.observe(node);
  }, [hasMore, loading, loadingMore, loadIssues]);

  const hasActiveFilters = !!debouncedSearch || publisherFilter !== 'ALL' || eraFilter !== 'ALL' || libraryFilter !== 'ALL' || statusFilter !== 'ALL' || sortOption !== DEFAULT_SORT || showCovered;
  const resetFilters = () => {
    setSearchQuery(""); setPublisherFilter("ALL"); setEraFilter("ALL");
    setLibraryFilter("ALL"); setStatusFilter("ALL"); setSortOption(DEFAULT_SORT); setShowCovered(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // What an owned collection covers is loaded but not shown until asked; the toggle only appears
  // once there is something behind it, and its count is what's actually loaded.
  const coveredCount = issues.filter(i => i.coveredBy).length;
  const visibleIssues = showCovered ? issues : issues.filter(i => !i.coveredBy);

  /**
   * The same request the series page files — the composite comes from the ONE shared helper, so
   * the downloader can never be handed a different search string from this door than from that one.
   */
  const requestIssue = async (row: IssueRow): Promise<boolean> => {
    // #200: parseFloat on a vulgar fraction is NaN; the helper falls back to the raw number, so a
    // request never says "#null" or "#NaN" (the series API does this server-side; here it's ours).
    const p = parseFloat(normalizeFractionNumbers(row.number));
    const { composite, reqNum } = requestNameFor({
      seriesName: row.seriesName, number: row.number, parsedNum: Number.isFinite(p) ? p : null,
      name: row.name, isAnnual: row.isAnnual, isCollected: row.isCollected, collectionName: row.collectionName,
      isSpecial: row.isSpecial, specialName: row.specialName,
    });
    setRequestingIds(prev => new Set(prev).add(row.id));
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'issue',
          cvId: row.seriesMetadataId,
          name: composite,
          year: (row.year ?? new Date().getFullYear()).toString(),
          publisher: row.publisher || 'Unknown',
          image: row.cover,
          issueNumber: reqNum || undefined,
          metadataSource: row.metadataSource || 'COMICVINE',
        }),
      });
      if (res.ok) {
        setRequestedIds(prev => new Set(prev).add(row.id));
        return true;
      }
      const data = await res.json().catch(() => ({}));
      toastRef.current({ title: "Request failed", description: data.error || `HTTP ${res.status}`, variant: "destructive" });
      return false;
    } catch {
      toastRef.current({ title: "Request failed", description: "Couldn't reach the server.", variant: "destructive" });
      return false;
    } finally {
      setRequestingIds(prev => { const next = new Set(prev); next.delete(row.id); return next; });
    }
  };

  // Everything on screen that can still be asked for. "Shown" is honest: it's the rows loaded so
  // far, which is what the user is looking at — not every wanted issue in the library. A covered
  // issue is never counted, shown or not: you have the story, and the bulk action asks for what's
  // missing. Its own Request button stays for the deliberate ask.
  const requestableShown = issues.filter(i => i.requestable && !i.coveredBy && !requestedIds.has(i.id));

  const requestAllShown = async () => {
    setBulkOpen(false);
    const targets = requestableShown;
    if (targets.length === 0) return;
    setBulkProgress({ done: 0, total: targets.length });
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      if (await requestIssue(targets[i])) ok++;
      setBulkProgress({ done: i + 1, total: targets.length });
      // Same pacing the series page uses: each request fans out into a search job.
      await new Promise(r => setTimeout(r, 300));
    }
    setBulkProgress(null);
    toastRef.current({ title: "Requests queued", description: `${ok} of ${targets.length} issues requested.` });
  };

  const triggerClass = "flex-1 sm:w-[140px] sm:flex-none h-10 sm:h-9 bg-background shadow-sm border-border";

  return (
    <div className="container mx-auto py-10 px-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div>
        <Link href="/library" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-1">
          <ChevronLeft className="w-4 h-4" /> Library
        </Link>
        {/* The Wanted view is its own destination — "Missing Issues" — so the entry points that
            link here land on a page that says what it is, not on "All Issues" with a select set. */}
        <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">
          {statusFilter === 'WANTED'
            ? <><BookCheck className="w-6 h-6 text-primary" /> Missing Issues</>
            : <><CalendarDays className="w-6 h-6 text-primary" /> All Issues</>}
        </h1>
        <p className="text-sm text-muted-foreground">
          {statusFilter === 'WANTED'
            ? "Issues your series are tracking that aren't on disk yet, across the whole library."
            : "Every individual issue across your library, ordered by release date."}
        </p>
      </div>
      {/* "Find them all and have it search" — one action for whatever the list is filtered to.
          Withdraws itself once nothing on screen is left to ask for. */}
      {canRequest && requestableShown.length > 0 && (
        <Button
          aria-label="Request every missing issue shown on this page"
          variant="outline"
          disabled={bulkProgress !== null}
          onClick={() => setBulkOpen(true)}
          className="h-10 sm:h-9 font-bold border-primary/30 text-primary hover:bg-primary/10 shrink-0"
        >
          {bulkProgress
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Requesting {bulkProgress.done}/{bulkProgress.total}…</>
            : <><DownloadCloud className="w-4 h-4 mr-2" /> Request all shown ({requestableShown.length})</>}
        </Button>
      )}
      </div>

      <ConfirmationDialog
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onConfirm={requestAllShown}
        title={`Request ${requestableShown.length} missing issue${requestableShown.length === 1 ? '' : 's'}?`}
        description="Each one becomes its own request and search, exactly as if you'd pressed Request on it. Anything you've already requested is skipped."
        confirmText="Request them"
        variant="default"
      />

      {/* Filters — contained in a panel to match the library view */}
      <div className="bg-muted/50 p-4 rounded-lg border border-border">
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 items-stretch sm:items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search issue or series title…"
            aria-label="Search issues"
            className="pl-9 h-10 sm:h-9 bg-background shadow-sm border-border"
          />
        </div>

        <Select value={sortOption} onValueChange={setSortOption}>
          <SelectTrigger aria-label="Sort issues" className={triggerClass}>
            <div className="flex items-center gap-2 truncate"><SortAsc className="w-3 h-3 shrink-0 text-muted-foreground" /> <SelectValue placeholder="Sort" /></div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="release_desc">Release Date (Newest)</SelectItem>
            <SelectItem value="release_asc">Release Date (Oldest)</SelectItem>
          </SelectContent>
        </Select>

        <Select value={eraFilter} onValueChange={setEraFilter}>
          <SelectTrigger aria-label="Filter by era" className={triggerClass}>
            <div className="flex items-center gap-2 truncate"><Clock className="w-3 h-3 shrink-0 text-muted-foreground" /> <SelectValue placeholder="Era" /></div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="ALL">All Eras</SelectItem>
            <SelectItem value="2020s">2020s</SelectItem>
            <SelectItem value="2010s">2010s</SelectItem>
            <SelectItem value="2000s">2000s</SelectItem>
            <SelectItem value="1990s">1990s</SelectItem>
            <SelectItem value="1980s">1980s</SelectItem>
            <SelectItem value="CLASSIC">Pre-1980s</SelectItem>
          </SelectContent>
        </Select>

        <Select value={publisherFilter} onValueChange={setPublisherFilter}>
          <SelectTrigger aria-label="Filter by publisher" className={triggerClass}>
            <div className="flex items-center gap-2 truncate"><Filter className="w-3 h-3 shrink-0 text-muted-foreground" /> <SelectValue placeholder="Publisher" /></div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="ALL">All Publishers</SelectItem>
            {publishers.map(pub => (<SelectItem key={pub} value={pub}>{pub}</SelectItem>))}
          </SelectContent>
        </Select>

        <Select value={libraryFilter} onValueChange={setLibraryFilter}>
          <SelectTrigger aria-label="Filter by library" className={triggerClass}>
            <div className="flex items-center gap-2 truncate"><LibraryIcon className="w-3 h-3 shrink-0 text-muted-foreground" /> <SelectValue placeholder="Library" /></div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="ALL">All Libraries</SelectItem>
            <SelectItem value="COMICS">Comics</SelectItem>
            <SelectItem value="MANGA">Manga</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger aria-label="Filter by download status" className={triggerClass}>
            <div className="flex items-center gap-2 truncate"><BookCheck className="w-3 h-3 shrink-0 text-muted-foreground" /> <SelectValue placeholder="Status" /></div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="ALL">All Issues</SelectItem>
            <SelectItem value="DOWNLOADED">Downloaded</SelectItem>
            <SelectItem value="WANTED">Wanted</SelectItem>
          </SelectContent>
        </Select>

        {coveredCount > 0 && (
          <Button
            variant={showCovered ? "secondary" : "outline"}
            aria-pressed={showCovered}
            aria-label={showCovered ? "Hide covered issues" : "Show covered issues"}
            title="Issues a collected edition you own reprints — not missing, but here if you want the singles"
            className="h-10 sm:h-9 font-bold border-border flex-1 sm:flex-none"
            onClick={() => setShowCovered(v => !v)}
          >
            <BookMarked className="w-4 h-4 mr-1 sm:mr-2 text-emerald-600 dark:text-emerald-400" />
            <span className="hidden sm:inline">{showCovered ? 'Hide' : 'Show'} covered ({coveredCount})</span>
            <span className="sm:hidden">{coveredCount}</span>
          </Button>
        )}

        {hasActiveFilters && (
          <Button aria-label="Clear all applied filters" variant="ghost" className="h-10 sm:h-9 text-muted-foreground hover:text-foreground px-3 flex-1 sm:flex-none" onClick={resetFilters}>
            <X className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline font-bold">Clear Filters</span>
          </Button>
        )}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <IssuesSkeleton count={24} />
      ) : issues.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground border-2 border-dashed rounded-lg border-border bg-muted/30">
          <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p>No issues found matching your criteria.</p>
          <p className="text-xs mt-1 opacity-70">Only released issues with a known release date are shown here.</p>
        </div>
      ) : visibleIssues.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground border-2 border-dashed rounded-lg border-border bg-muted/30">
          <BookMarked className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p>Everything here is covered by collected editions you own.</p>
          <p className="text-xs mt-1 opacity-70">{coveredCount} issue{coveredCount === 1 ? '' : 's'} — use &quot;Show covered&quot; above to see them.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10">
          {visibleIssues.map((issue) => (
            <div key={issue.id} className="flex flex-col space-y-2">
            <Link
              href={issue.seriesPath ? `/library/series?path=${encodeURIComponent(issue.seriesPath)}` : '#'}
              className="group flex flex-col space-y-2"
              aria-label={`${issue.seriesName} #${issue.number}`}
            >
              <Card className="aspect-[2/3] overflow-hidden shadow-sm transition-all p-0 relative border-border group-hover:shadow-md bg-background">
                <div className="relative w-full h-full bg-muted flex items-center justify-center overflow-hidden">
                  <ImageIcon className="w-8 h-8 text-muted-foreground/30 absolute z-0" />
                  {issue.cover && (
                    <img
                      src={issue.cover}
                      alt=""
                      loading="lazy"
                      className={`object-cover w-full h-full relative z-10 transition-opacity ${issue.onDisk ? '' : 'opacity-70'}`}
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  )}
                  <div className="absolute top-1.5 left-1.5 z-30 flex flex-col gap-1 items-start">
                    <Badge className="bg-black/70 hover:bg-black/70 text-white border-0 shadow-sm px-1.5 h-4 text-[9px] font-black uppercase tracking-wider backdrop-blur-sm">#{issue.number}</Badge>
                    {!issue.onDisk && (issue.coveredBy
                      ? <Badge className="bg-emerald-600 hover:bg-emerald-700 text-white border-0 shadow-sm px-1.5 h-4 text-[9px] font-black uppercase tracking-wider" title={`Covered by ${coveredByLabel(issue.coveredBy)}`}>Covered</Badge>
                      : <Badge className="bg-blue-500 hover:bg-blue-600 text-white border-0 shadow-sm px-1.5 h-4 text-[9px] font-black uppercase tracking-wider">Wanted</Badge>
                    )}
                  </div>
                  {issue.releaseDate && (
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 backdrop-blur-sm text-white text-[10px] font-mono text-center py-0.5 z-20">{issue.releaseDate}</div>
                  )}
                </div>
              </Card>
              <div className="px-0.5 min-w-0">
                <p className="text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">{issue.seriesName}</p>
                <p className="text-[10px] text-muted-foreground truncate">{issue.name ? issue.name : `Issue #${issue.number}`}</p>
                {issue.coveredBy && (
                  <p className="text-[10px] text-emerald-700 dark:text-emerald-400 truncate" title={coveredByLabel(issue.coveredBy)}>Covered by {coveredByLabel(issue.coveredBy)}</p>
                )}
              </div>
            </Link>
              {/* A button can't live inside the link — it sits beneath it, so the card still opens
                  the series and the request is its own, deliberate click. Only where the API says a
                  request can resolve (a matched series), and only for users allowed to ask. */}
              {canRequest && !issue.onDisk && issue.requestable && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Request ${issue.seriesName} #${issue.number}`}
                  disabled={requestingIds.has(issue.id) || requestedIds.has(issue.id)}
                  onClick={() => requestIssue(issue)}
                  className="h-8 text-[10px] font-black uppercase tracking-wider border-primary/30 text-primary hover:bg-primary/10"
                >
                  {requestingIds.has(issue.id)
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : requestedIds.has(issue.id)
                      ? <><Check className="w-3.5 h-3.5 mr-1" /> Requested</>
                      : <><DownloadCloud className="w-3.5 h-3.5 mr-1" /> Request</>}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Infinite-scroll sentinel */}
      {hasMore && !loading && (
        <div ref={lastElementRef} className="flex justify-center pt-8 pb-12 w-full">
          {loadingMore ? (
            <div className="flex items-center text-muted-foreground font-medium bg-muted/50 px-4 py-2 rounded-full border border-border shadow-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading more…
            </div>
          ) : (
            <div className="h-10 w-full" />
          )}
        </div>
      )}
    </div>
  );
}

/** useSearchParams needs a Suspense boundary in the app router (the series page sets the same
 *  precedent); the fallback keeps the page's frame so nothing jumps when the filters resolve. */
export default function LibraryIssuesPage() {
  return (
    <Suspense fallback={<div className="container mx-auto py-10 px-6"><IssuesSkeleton /></div>}>
      <LibraryIssuesInner />
    </Suspense>
  );
}
