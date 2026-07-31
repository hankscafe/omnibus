"use client";

// Shared follow toggle bell (Beta C): controlled by the owning page, which holds the user's
// followed-set (from GET /api/library/follow) and passes per-item state down. Optimistic — the
// parent updates its set via onToggled immediately; a failed request rolls it back with a toast.
// Uses the explicit `follow` body so a double-click can't invert intent mid-flight.
import { useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

interface FollowBellProps {
    seriesId: string;
    seriesName?: string;
    isFollowing: boolean;
    onToggled: (seriesId: string, isFollowing: boolean) => void;
    className?: string;
    variant?: "secondary" | "ghost" | "outline";
    size?: "icon-sm" | "icon" | "sm";
}

export function FollowBell({ seriesId, seriesName, isFollowing, onToggled, className, variant = "secondary", size = "icon-sm" }: FollowBellProps) {
    const [busy, setBusy] = useState(false);
    const { toast } = useToast();

    const toggle = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        const next = !isFollowing;
        setBusy(true);
        onToggled(seriesId, next);
        try {
            const res = await fetch('/api/library/follow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seriesId, follow: next }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
            onToggled(seriesId, !next);
            toast({ title: "Error", description: "Failed to update follows.", variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Button
            variant={variant}
            size={size}
            className={cn("shadow-md", className)}
            onClick={toggle}
            disabled={busy}
            title={isFollowing ? `Unfollow${seriesName ? ` ${seriesName}` : ''} — stop showing new arrivals in your Updates feed` : `Follow${seriesName ? ` ${seriesName}` : ''} — new arrivals show in your Updates feed. Never triggers downloads.`}
            aria-label={isFollowing ? `Unfollow ${seriesName || 'series'}` : `Follow ${seriesName || 'series'}`}
            aria-pressed={isFollowing}
        >
            {isFollowing ? <BellRing className="w-4 h-4 text-primary" /> : <Bell className="w-4 h-4" />}
        </Button>
    );
}
