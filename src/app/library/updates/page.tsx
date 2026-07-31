"use client";

// /library/updates — the Following-only Updates feed (Beta B of the follow model). Day-grouped
// arrivals in series the user follows, with same-day series clustering (a chapter dump is one
// expandable row), an unread-only toggle persisted like the other view prefs, and a plain-refetch
// refresh. Whole-library arrivals deliberately live elsewhere (home's Recently Added).
import { useEffect, useMemo, useState } from "react";
import { Bell, BookOpen, ChevronDown, ChevronLeft, ChevronUp, History, Loader2, RefreshCw, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { coverSrc } from "@/lib/utils/cover-url";
import { groupUpdates, dayLabel, filterUnread } from "@/lib/utils/updates-view";

const UNREAD_KEY = 'omnibus_updates_unread';

export default function UpdatesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const router = useRouter();

  const load = async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true);
    try {
        const res = await fetch('/api/library/updates');
        if (res.ok) {
            const data = await res.json();
            setItems(data.items || []);
        }
    } finally {
        setLoading(false);
        setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    if (localStorage.getItem(UNREAD_KEY) === '1') setUnreadOnly(true);
  }, []);

  const toggleUnread = () => {
    const next = !unreadOnly;
    setUnreadOnly(next);
    localStorage.setItem(UNREAD_KEY, next ? '1' : '0');
  };

  const groups = useMemo(() => groupUpdates(filterUnread(items, unreadOnly)), [items, unreadOnly]);

  const openReader = (item: any) =>
      router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`);

  const toggleExpand = (key: string) =>
      setExpanded(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  const itemRow = (item: any, indented = false) => (
      <div
          key={item.id}
          className={cn("group flex items-center gap-3 p-2.5 bg-background border border-border rounded-xl shadow-sm hover:border-primary/50 cursor-pointer transition-all", indented && "ml-10")}
          onClick={() => openReader(item)}
      >
          <div className="w-9 h-13 sm:w-10 sm:h-14 shrink-0 rounded overflow-hidden bg-muted border border-border">
              {item.coverUrl && <img src={coverSrc(item.coverUrl, 160)} className="w-full h-full object-cover" alt="" loading="lazy" />}
          </div>
          <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                  {!item.isRead && <span className="w-2 h-2 rounded-full bg-primary shrink-0" aria-label="Unread" />}
                  <h3 className="text-sm font-bold truncate text-foreground group-hover:text-primary transition-colors">{item.seriesName}</h3>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                  Issue #{item.number}{item.name ? ` • ${item.name}` : ''}
              </p>
          </div>
          <span className="hidden sm:block text-[10px] font-mono text-muted-foreground shrink-0">
              {new Date(item.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
          <Button
              size="sm"
              className="h-8 shrink-0 font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0"
              onClick={(e) => { e.stopPropagation(); openReader(item); }}
          >
              <BookOpen className="w-3 h-3 sm:mr-2" /> <span className="hidden sm:inline">{item.isRead ? "Re-read" : "Read"}</span>
          </Button>
      </div>
  );

  return (
    <div className="container mx-auto py-10 px-6 transition-colors duration-300">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => router.back()} className="hover:bg-muted text-foreground">
            <ChevronLeft className="w-6 h-6" />
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
            <Bell className="w-8 h-8 text-primary" /> Updates
        </h1>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-8">
          <Button
              variant={unreadOnly ? "default" : "outline"}
              size="sm"
              onClick={toggleUnread}
              className={cn("font-bold", unreadOnly ? "bg-primary hover:bg-primary/90 text-primary-foreground border-0" : "border-border")}
          >
              Unread only
          </Button>
          <Button variant="outline" size="sm" className="font-bold border-border" onClick={() => load(true)} disabled={refreshing}>
              {refreshing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />} Refresh
          </Button>
          <div className="flex items-center gap-3 sm:ml-auto text-sm">
              <Link href="/library/history" className="flex items-center gap-1.5 text-muted-foreground hover:text-primary font-bold transition-colors">
                  <History className="w-4 h-4" /> Reading History
              </Link>
              <Link href="/calendar" className="flex items-center gap-1.5 text-muted-foreground hover:text-primary font-bold transition-colors">
                  <CalendarDays className="w-4 h-4" /> Release Calendar
              </Link>
          </div>
      </div>

      {loading ? (
        <div className="space-y-3">
            {[1,2,3,4,5,6].map(i => <div key={i} className="h-16 bg-muted animate-pulse rounded-xl border border-border" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl transition-colors duration-300">
            <Bell className="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
            <h3 className="text-lg font-bold text-foreground">No recent arrivals in series you follow</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                Follow series with the bell button on any series page — new issues that land in your library will show up here. Requesting a series follows it automatically.
            </p>
            <Button className="mt-4 font-bold bg-primary hover:bg-primary/90 text-primary-foreground" asChild><Link href="/library">Browse Library</Link></Button>
        </div>
      ) : groups.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl transition-colors duration-300">
            <p className="text-muted-foreground text-lg font-bold">All caught up!</p>
            <p className="text-sm text-muted-foreground mt-1">Every recent arrival in your followed series has been read.</p>
        </div>
      ) : (
        <div className="space-y-8 pb-10">
            {groups.map(group => (
                <div key={group.dayKey}>
                    <div className="flex items-center gap-3 mb-3">
                        <h2 className="text-sm font-black uppercase tracking-widest text-muted-foreground">{dayLabel(group.dayKey)}</h2>
                        <div className="flex-1 h-px bg-border" />
                        <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-primary/20">
                            {group.clusters.reduce((n, c) => n + c.items.length, 0)}
                        </Badge>
                    </div>
                    <div className="space-y-2">
                        {group.clusters.map(cluster => {
                            const key = `${group.dayKey}|${cluster.seriesId}`;
                            if (cluster.items.length === 1) return itemRow(cluster.items[0]);
                            const isOpen = expanded.has(key);
                            const unreadCount = cluster.items.filter(i => !i.isRead).length;
                            return (
                                <div key={key}>
                                    <div
                                        className="group flex items-center gap-3 p-2.5 bg-muted/40 border border-border rounded-xl shadow-sm hover:border-primary/50 cursor-pointer transition-all"
                                        onClick={() => toggleExpand(key)}
                                    >
                                        <div className="w-9 h-13 sm:w-10 sm:h-14 shrink-0 rounded overflow-hidden bg-muted border border-border">
                                            {cluster.items[0].coverUrl && <img src={coverSrc(cluster.items[0].coverUrl, 160)} className="w-full h-full object-cover" alt="" loading="lazy" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                {unreadCount > 0 && <span className="w-2 h-2 rounded-full bg-primary shrink-0" aria-label="Unread" />}
                                                <h3 className="text-sm font-bold truncate text-foreground group-hover:text-primary transition-colors">{cluster.seriesName}</h3>
                                            </div>
                                            <p className="text-xs text-muted-foreground">{cluster.items.length} new issues{unreadCount > 0 && unreadCount < cluster.items.length ? ` • ${unreadCount} unread` : ''}</p>
                                        </div>
                                        <div className="bg-background rounded-full p-1 shadow-sm border border-border shrink-0">
                                            {isOpen ? <ChevronUp className="w-4 h-4 text-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                                        </div>
                                    </div>
                                    {isOpen && (
                                        <div className="mt-2 space-y-2">
                                            {cluster.items.map(item => itemRow(item, true))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
      )}
    </div>
  );
}
