"use client";

// Collapsible "Updates" section for the profile page (Adam's call 2026-07-31: Updates/History
// don't belong in the header — the profile is the personal hub, so this section is the primary
// doorway to /library/updates). Shows the newest arrivals in followed series via the existing
// feed API; expanded by default, collapse state persisted per browser.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, BookOpen, ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { coverSrc } from "@/lib/utils/cover-url";
import { dayKeyOf, dayLabel } from "@/lib/utils/updates-view";

const OPEN_KEY = 'omnibus_profile_updates_open';
const MAX_SHOWN = 9; // fills the 3-column grid three rows deep at most

export function ProfileUpdatesSection() {
    const [items, setItems] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState(true);
    const router = useRouter();

    useEffect(() => {
        fetch('/api/library/updates')
            .then(res => res.ok ? res.json() : { items: [] })
            .then(data => setItems((data.items || []).slice(0, MAX_SHOWN)))
            .catch(() => {})
            .finally(() => setLoading(false));
        if (localStorage.getItem(OPEN_KEY) === '0') setOpen(false);
    }, []);

    const toggleOpen = () => {
        const next = !open;
        setOpen(next);
        localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    };

    const unreadCount = items.filter(i => !i.isRead).length;

    if (loading) return null;

    return (
        <div className="space-y-3 pt-4 border-t border-border">
            <div className="flex items-center justify-between">
                <button type="button" onClick={toggleOpen} aria-expanded={open} className="flex items-center gap-2 text-sm font-bold text-foreground hover:text-primary transition-colors">
                    <Bell className="w-4 h-4 text-primary" /> Updates
                    {unreadCount > 0 && (
                        <Badge className="h-5 px-1.5 text-[10px] bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">{unreadCount} unread</Badge>
                    )}
                    {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </button>
                <Button variant="ghost" size="sm" className="h-8 text-xs font-bold text-muted-foreground hover:text-foreground" asChild>
                    <Link href="/library/updates">View All Updates <ArrowRight className="w-3 h-3 ml-1.5" /></Link>
                </Button>
            </div>

            {open && (
                items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        New issues arriving in series you follow appear here. Follow series with the bell button — requesting one follows it automatically.
                    </p>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {items.map((item: any) => (
                            <Card
                                key={item.id}
                                className="shadow-sm bg-background border-border overflow-hidden hover:border-primary/50 transition-colors cursor-pointer group"
                                onClick={() => router.push(`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.seriesPath)}`)}
                            >
                                <CardContent className="p-4 flex items-center gap-4">
                                    <div className="w-14 h-20 bg-muted rounded shrink-0 border border-border flex items-center justify-center overflow-hidden relative">
                                        {item.coverUrl ? <img src={coverSrc(item.coverUrl, 160)} className="w-full h-full object-cover absolute inset-0 z-10" alt="" loading="lazy" onError={(e) => { e.currentTarget.style.opacity = '0'; }} /> : <BookOpen className="w-5 h-5 text-muted-foreground absolute z-0" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            {!item.isRead && <span className="w-2 h-2 rounded-full bg-primary shrink-0" aria-label="Unread" />}
                                            <p className="font-bold text-sm truncate group-hover:text-primary transition-colors" title={item.seriesName}>{item.seriesName}</p>
                                        </div>
                                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mt-0.5">Issue #{item.number}</p>
                                        <p className={cn("text-[10px] font-bold uppercase tracking-wider mt-2", dayLabel(dayKeyOf(new Date(item.createdAt))) === 'Today' ? "text-primary" : "text-muted-foreground")}>
                                            {dayLabel(dayKeyOf(new Date(item.createdAt)))}
                                        </p>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )
            )}
        </div>
    );
}
