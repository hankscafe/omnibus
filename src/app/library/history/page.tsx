"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpen, History, ChevronLeft, Search, LayoutGrid, Grid3x3, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { filterHistory, sortHistory, HISTORY_SORTS, type HistorySort, type HistoryView } from "@/lib/utils/history-view";

// localStorage keys follow the Library page's view-toggle persistence pattern (fork review #3).
const VIEW_KEY = 'omnibus_history_view';
const SORT_KEY = 'omnibus_history_sort';

export default function HistoryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<HistorySort>('recent');
  const [viewMode, setViewMode] = useState<HistoryView>('grid');
  const router = useRouter();

  useEffect(() => {
    fetch('/api/progress/history')
      .then(res => res.json())
      .then(data => setItems(data.items || []))
      .finally(() => setLoading(false));

    const savedView = localStorage.getItem(VIEW_KEY);
    if (savedView === 'grid' || savedView === 'compact' || savedView === 'list') setViewMode(savedView);
    const savedSort = localStorage.getItem(SORT_KEY);
    if (HISTORY_SORTS.some(s => s.value === savedSort)) setSortBy(savedSort as HistorySort);
  }, []);

  const changeView = (mode: HistoryView) => { setViewMode(mode); localStorage.setItem(VIEW_KEY, mode); };
  const changeSort = (sort: HistorySort) => { setSortBy(sort); localStorage.setItem(SORT_KEY, sort); };

  const visibleItems = useMemo(() => sortHistory(filterHistory(items, search), sortBy), [items, search, sortBy]);

  const openReader = (item: any) =>
      router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`);

  // The full-size card shared by grid + compact; compact just packs more columns.
  const renderCard = (item: any, compact: boolean) => (
      <div
          key={item.id}
          className="group space-y-2 cursor-pointer"
          onClick={() => openReader(item)}
      >
          <div className="relative aspect-[2/3] rounded-xl overflow-hidden border border-border shadow-sm bg-muted transition-[transform,box-shadow] duration-200 group-hover:shadow-md group-hover:scale-[1.02] group-hover:ring-2 group-hover:ring-primary">
              <img src={item.seriesCoverUrl} className="w-full h-full object-cover" alt="" loading="lazy" />

              {/* Gradient for progress bar visibility */}
              <div className="absolute inset-0 bg-linear-to-t from-black/80 via-transparent to-transparent z-10 pointer-events-none group-hover:opacity-0 transition-opacity duration-200" />

              {/* Hover action overlay */}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center p-4 z-20">
                  <Button
                      size="sm"
                      className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 shadow-md"
                      onClick={(e) => { e.stopPropagation(); openReader(item); }}
                  >
                      <BookOpen className="w-3 h-3 mr-2" /> {item.isCompleted ? "Re-read" : "Resume"}
                  </Button>
              </div>

              {/* Floating Progress Bar */}
              <div className="absolute bottom-0 left-0 w-full p-2 z-20 group-hover:opacity-0 transition-opacity duration-200 pointer-events-none">
                  <div className="flex justify-end mb-1">
                      <p className="text-white/90 text-[10px] font-mono drop-shadow-md">{item.percentage}%</p>
                  </div>
                  <div className="w-full bg-white/30 h-1.5 rounded-full overflow-hidden backdrop-blur-xs">
                      <div className="bg-primary h-full transition-[width] duration-300 ease-out shadow-sm shadow-primary/50" style={{ width: `${item.percentage}%` }} />
                  </div>
              </div>
          </div>
          <div className="px-0.5">
              <h3 className={cn("font-bold truncate text-foreground group-hover:text-primary transition-colors duration-200", compact ? "text-xs" : "text-sm")}>{item.seriesName}</h3>
              {!compact && <p className="text-xs text-muted-foreground">Issue #{item.issueNumber}</p>}
          </div>
      </div>
  );

  return (
    <div className="container mx-auto py-10 px-6 transition-colors duration-300">
        <title>Omnibus - Reading History</title>
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => router.back()} className="hover:bg-muted text-foreground">
            <ChevronLeft className="w-6 h-6" />
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
            <History className="w-8 h-8 text-primary" /> Reading History
        </h1>
      </div>

      {/* Filter / sort / view controls (fork review #3) — all client-side over the full data set. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-8">
          <div className="relative flex-1 sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                  placeholder="Search history..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 bg-background border-border"
              />
          </div>
          <Select value={sortBy} onValueChange={(v) => changeSort(v as HistorySort)}>
              <SelectTrigger className="w-full sm:w-[190px] bg-background border-border">
                  <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                  {HISTORY_SORTS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
          </Select>
          <div className="flex items-center gap-1 bg-muted p-1 rounded-md border border-border shadow-inner sm:ml-auto self-start">
              <Button variant="ghost" size="sm" aria-label="Grid view" title="Grid" onClick={() => changeView('grid')} className={cn("h-8 px-2.5", viewMode === 'grid' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}>
                  <LayoutGrid className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" aria-label="Compact view" title="Compact" onClick={() => changeView('compact')} className={cn("h-8 px-2.5", viewMode === 'compact' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}>
                  <Grid3x3 className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" aria-label="List view" title="List" onClick={() => changeView('list')} className={cn("h-8 px-2.5", viewMode === 'list' ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}>
                  <List className="w-4 h-4" />
              </Button>
          </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
            {[1,2,3,4,5,6].map(i => <div key={i} className="aspect-[2/3] bg-muted animate-pulse rounded-xl border border-border" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl transition-colors duration-300">
            <p className="text-muted-foreground text-lg">You haven't started any comics yet!</p>
            <Button className="mt-4 font-bold bg-primary hover:bg-primary/90 text-primary-foreground" asChild><Link href="/">Go Discover</Link></Button>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl transition-colors duration-300">
            <p className="text-muted-foreground text-lg">Nothing matches "{search}".</p>
        </div>
      ) : viewMode === 'list' ? (
        <div className="space-y-2 pb-10">
            {visibleItems.map((item) => (
                <div
                    key={item.id}
                    className="group flex items-center gap-4 p-3 bg-background border border-border rounded-xl shadow-sm hover:border-primary/50 cursor-pointer transition-all"
                    onClick={() => openReader(item)}
                >
                    <div className="w-10 h-14 shrink-0 rounded overflow-hidden bg-muted border border-border">
                        <img src={item.seriesCoverUrl} className="w-full h-full object-cover" alt="" loading="lazy" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-bold truncate text-foreground group-hover:text-primary transition-colors">{item.seriesName}</h3>
                        <p className="text-xs text-muted-foreground">Issue #{item.issueNumber}</p>
                    </div>
                    <div className="hidden sm:flex items-center gap-3 w-40 shrink-0">
                        <div className="flex-1 bg-muted h-1.5 rounded-full overflow-hidden">
                            <div className="bg-primary h-full" style={{ width: `${item.percentage}%` }} />
                        </div>
                        <span className="text-[10px] font-mono text-muted-foreground w-9 text-right">{item.percentage}%</span>
                    </div>
                    <Button
                        size="sm"
                        className="h-8 shrink-0 font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0"
                        onClick={(e) => { e.stopPropagation(); openReader(item); }}
                    >
                        <BookOpen className="w-3 h-3 sm:mr-2" /> <span className="hidden sm:inline">{item.isCompleted ? "Re-read" : "Resume"}</span>
                    </Button>
                </div>
            ))}
        </div>
      ) : (
        <div className={cn(
            "gap-6 grid",
            viewMode === 'compact'
                ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-3"
                : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8"
        )}>
            {visibleItems.map((item) => renderCard(item, viewMode === 'compact'))}
        </div>
      )}
    </div>
  );
}
