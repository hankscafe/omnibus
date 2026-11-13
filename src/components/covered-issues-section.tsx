// src/components/covered-issues-section.tsx
//
// #203 COLLECTED coverage (field report by robotshavehearts2): the series page's shelf for the
// singles an OWNED collected edition reprints. They are not missing — you have the story — and they
// are not on disk either, so they read as their own list, each naming the book that covers it. A
// deliberate Request is still offered: coverage is a fact about the story, not a ban on the single.
"use client"

import type { SyntheticEvent } from "react";
import { BookMarked, Check, CloudDownload, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CoveredBy {
    id?: string;
    number: string;
    name: string | null;
    collectionName: string | null;
}

export interface CoveredIssue {
    id: string;
    number: string;
    parsedNum?: number | null;
    name: string | null;
    coverUrl?: string | null;
    isAnnual?: boolean;
    coveredBy: CoveredBy;
}

/** How a covering book is named on a card: its own title, else "<collection> Vol. N". */
export function coveredByLabel(b: CoveredBy): string {
    if (b.name) return b.name;
    return b.collectionName ? `${b.collectionName} Vol. ${b.number}` : `Vol. ${b.number}`;
}

// Generic so Request and select hand back the very rows the page passed in (the series page's full
// shelf rows), not just the fields this section reads.
interface CoveredIssuesSectionProps<T extends CoveredIssue> {
    issues: T[];
    seriesName: string;
    seriesCover: string | null;
    canRequest: boolean;
    requestingIds: Set<string>;
    requestedIds: Set<string>;
    onRequest: (issue: T) => void;
    onSelect: (issue: T) => void;
}

const coverImgError = (fallback: string | null) => (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.dataset.fb === '1') { img.style.visibility = 'hidden'; return; }
    img.dataset.fb = '1';
    if (fallback) img.src = fallback; else img.style.visibility = 'hidden';
};

export function CoveredIssuesSection<T extends CoveredIssue>({ issues, seriesName, seriesCover, canRequest, requestingIds, requestedIds, onRequest, onSelect }: CoveredIssuesSectionProps<T>) {
    if (issues.length === 0) return null;
    return (
        <div className="space-y-6 pt-4 border-t-2 border-border">
            <div>
                <h4 className="font-black flex items-center gap-2 text-xl text-foreground tracking-tight">
                    <BookMarked className="w-6 h-6 text-primary" /> Covered by Collected Editions ({issues.length})
                </h4>
                <p className="text-sm text-muted-foreground mt-1">
                    Singles you don&apos;t have on disk, but a collection you own reprints them — so they aren&apos;t missing. Request one anyway if you want the single.
                </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-6 pb-10">
                {issues.map((issue) => {
                    const isRequesting = requestingIds.has(issue.id);
                    const isRequested = requestedIds.has(issue.id);
                    const label = coveredByLabel(issue.coveredBy);
                    const cover = issue.coverUrl || seriesCover;
                    return (
                        <div
                            key={issue.id}
                            onClick={() => onSelect(issue)}
                            className="flex gap-4 p-4 bg-background border border-border rounded-xl shadow-sm transition-all cursor-pointer hover:border-primary/50"
                        >
                            <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden bg-muted border border-border">
                                {cover
                                    ? <img src={cover} onError={coverImgError(seriesCover)} className="w-full h-full object-cover opacity-80" alt="" />
                                    : <ImageIcon className="w-8 h-8 m-auto mt-10 text-muted-foreground/50" />}
                            </div>
                            <div className="flex flex-col justify-between flex-1 py-1 min-w-0">
                                <div className="min-w-0">
                                    <h5 className="font-bold text-base line-clamp-2 text-foreground leading-tight">{issue.name}</h5>
                                    <span className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">{issue.isAnnual ? 'Annual' : 'Issue'} #{issue.parsedNum ?? issue.number}</span>
                                    <div className="mt-2">
                                        <Badge
                                            className="max-w-full bg-emerald-600/15 hover:bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border border-emerald-600/30 text-[10px] font-bold whitespace-normal text-left"
                                            title={issue.coveredBy.collectionName ? `${issue.coveredBy.collectionName} · Vol. ${issue.coveredBy.number}` : undefined}
                                        >
                                            Covered by {label}
                                        </Badge>
                                    </div>
                                </div>
                                {canRequest && (
                                    <div className="flex flex-wrap items-center gap-2 mt-3">
                                        {isRequested ? (
                                            <Button size="sm" variant="secondary" disabled aria-label={`Request ${seriesName} #${issue.number}`} className="flex-1 h-9 bg-green-50 text-green-700 dark:bg-green-900/20 border-green-200 opacity-100 cursor-not-allowed">
                                                <Check className="w-4 h-4 mr-2" /> Queued
                                            </Button>
                                        ) : (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                aria-label={`Request ${seriesName} #${issue.number}`}
                                                className={cn("flex-1 h-9 font-black text-[10px] border-border hover:bg-muted uppercase tracking-wider min-w-[80px]")}
                                                onClick={(e) => { e.stopPropagation(); onRequest(issue); }}
                                                disabled={isRequesting}
                                            >
                                                {isRequesting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CloudDownload className="w-4 h-4 mr-2" />}Request
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
