"use client";

// Floating Plex-style letter rail for the library page (Beta E, 2026-07-25 worklist item 6).
// Rendered only on the alphabetical sorts; letters with no series under the current filters are
// dimmed and unclickable; the letter under the current scroll position carries the highlight.
import { cn } from "@/lib/utils";
import type { LetterBucket } from "@/lib/utils/alpha-buckets";

const RAIL = ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

export function AlphaJumpBar({ buckets, activeLetter, onJump, className }: {
    buckets: LetterBucket[];
    activeLetter: string | null;
    onJump: (bucket: LetterBucket) => void;
    className?: string;
}) {
    if (buckets.length === 0) return null;
    const byLetter = new Map(buckets.map(b => [b.letter, b]));

    return (
        <nav
            aria-label="Jump to letter"
            className={cn(
                "fixed right-1.5 top-1/2 -translate-y-1/2 z-30 hidden md:flex flex-col items-center",
                "rounded-full border border-border bg-background/85 backdrop-blur-sm shadow-md py-1.5 px-0.5",
                className
            )}
        >
            {RAIL.map(letter => {
                const bucket = byLetter.get(letter);
                const active = activeLetter === letter;
                return (
                    <button
                        key={letter}
                        type="button"
                        aria-label={`Jump to ${letter}`}
                        data-active={active ? 'true' : 'false'}
                        disabled={!bucket}
                        onClick={() => bucket && onJump(bucket)}
                        title={bucket ? `${bucket.count} series` : undefined}
                        className={cn(
                            "w-5 leading-[1.15] text-[10px] font-bold rounded-full text-center transition-colors",
                            bucket ? "text-muted-foreground hover:text-primary cursor-pointer" : "text-muted-foreground/30 cursor-default",
                            active && "bg-primary text-primary-foreground hover:text-primary-foreground"
                        )}
                    >
                        {letter}
                    </button>
                );
            })}
        </nav>
    );
}
