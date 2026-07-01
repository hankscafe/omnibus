// src/app/library/issues/page.tsx
"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Image as ImageIcon, Loader2, Search, SortAsc, Filter, Clock, X,
  CalendarDays, ChevronLeft, Library as LibraryIcon, BookCheck
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
}

const DEFAULT_SORT = "release_desc";

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

export default function LibraryIssuesPage() {
  const { toast } = useToast();
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
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [publisherFilter, setPublisherFilter] = useState("ALL");
  const [eraFilter, setEraFilter] = useState("ALL");
  const [libraryFilter, setLibraryFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sortOption, setSortOption] = useState(DEFAULT_SORT);

  // Mirror filters into a ref so loadIssues (a stable useCallback) reads current values without deps churn.
  const filtersRef = useRef({ search: "", publisher: "ALL", era: "ALL", library: "ALL", status: "ALL", sort: DEFAULT_SORT });
  useEffect(() => {
    filtersRef.current = { search: debouncedSearch, publisher: publisherFilter, era: eraFilter, library: libraryFilter, status: statusFilter, sort: sortOption };
  }, [debouncedSearch, publisherFilter, eraFilter, libraryFilter, statusFilter, sortOption]);

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

  const observer = useRef<IntersectionObserver | null>(null);
  const lastElementRef = useCallback((node: HTMLDivElement | null) => {
    if (loading || loadingMore) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) loadIssues(false);
    }, { rootMargin: "400px" });
    if (node) observer.current.observe(node);
  }, [hasMore, loading, loadingMore, loadIssues]);

  const hasActiveFilters = !!debouncedSearch || publisherFilter !== 'ALL' || eraFilter !== 'ALL' || libraryFilter !== 'ALL' || statusFilter !== 'ALL' || sortOption !== DEFAULT_SORT;
  const resetFilters = () => {
    setSearchQuery(""); setPublisherFilter("ALL"); setEraFilter("ALL");
    setLibraryFilter("ALL"); setStatusFilter("ALL"); setSortOption(DEFAULT_SORT);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const triggerClass = "flex-1 sm:w-[140px] sm:flex-none h-10 sm:h-9 bg-background shadow-sm border-border";

  return (
    <div className="container mx-auto py-10 px-6 space-y-6">
      <div>
        <Link href="/library" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-1">
          <ChevronLeft className="w-4 h-4" /> Library
        </Link>
        <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">
          <CalendarDays className="w-6 h-6 text-primary" /> All Issues
        </h1>
        <p className="text-sm text-muted-foreground">Every individual issue across your library, ordered by release date.</p>
      </div>

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
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10">
          {issues.map((issue) => (
            <Link
              key={issue.id}
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
                    {!issue.onDisk && (
                      <Badge className="bg-blue-500 hover:bg-blue-600 text-white border-0 shadow-sm px-1.5 h-4 text-[9px] font-black uppercase tracking-wider">Wanted</Badge>
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
              </div>
            </Link>
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
