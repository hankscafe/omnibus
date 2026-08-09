// src/app/admin/smart-match/page.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Sparkles, Check, X, FolderSearch, ArrowRight, Image as ImageIcon, ArrowLeft, FileText, Search, Square, CheckSquare, CheckCheck, ExternalLink, Pencil, FolderTree, Upload, BookOpen, ChevronLeft, ChevronRight, History, RefreshCw, Layers } from "lucide-react"
import PageManagerModal, { PageManagerTarget } from "@/components/page-manager-modal"
import Link from "next/link"
import { Logger } from "@/lib/logger"
import { getErrorMessage } from "@/lib/utils/error"
import { extractIssueNumber } from "@/lib/utils/issue-parser"
import { buildManualSuggestion, buildKeepCarry, cleanProviderId, findIssueIdByNumber, resolveIssueIdByNumber } from "@/lib/utils/smart-match-search"
import SmartMatchMetadataDialog, { type SmartMatchOverride, buildFolderPreview, shouldEmbedIssueCover, COMIC_INFO_DEFAULT_KEYS } from "@/components/smart-match-metadata-dialog"
import SmartMatchBoundIssue from "@/components/smart-match-bound-issue"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"

// Auto-scan results (the ComicVine/Metron match suggestions) are kept in sessionStorage so a page
// refresh or navigate-away-and-back restores them instead of re-running the scan. The cache is
// provider-scoped and shares the 12h TTL of the server-side /api/search cache so client and server
// expire in lockstep. sessionStorage (not localStorage) clears on tab close, which matches the
// volatile nature of a matching session.
const SCAN_CACHE_PREFIX = 'omnibus-smartmatch-suggestions';
const SCAN_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function readScanCache(provider: string): Record<string, any> {
    try {
        const raw = sessionStorage.getItem(`${SCAN_CACHE_PREFIX}-${provider}`);
        if (!raw) return {};
        const env = JSON.parse(raw);
        if (!env || typeof env.ts !== 'number' || Date.now() - env.ts > SCAN_CACHE_TTL_MS) {
            sessionStorage.removeItem(`${SCAN_CACHE_PREFIX}-${provider}`);
            return {};
        }
        return env.data && typeof env.data === 'object' ? env.data : {};
    } catch {
        return {};
    }
}

function writeScanCache(provider: string, data: Record<string, any>) {
    try {
        if (!data || Object.keys(data).length === 0) {
            sessionStorage.removeItem(`${SCAN_CACHE_PREFIX}-${provider}`);
            return;
        }
        sessionStorage.setItem(`${SCAN_CACHE_PREFIX}-${provider}`, JSON.stringify({ ts: Date.now(), data }));
    } catch {}
}

function timeAgo(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

// One-line status of the background unmatched sweep (discussion #177), from /api/admin/sweep.
function describeSweep(info: any): string {
    const r = info?.lastResult;
    if (!r) {
        const triggered = Number(info?.lastTriggered);
        return triggered > 0
            ? `Last triggered ${timeAgo(triggered)} — no result recorded yet.`
            : 'Retries unmatched items automatically using embedded file IDs (plus provider search in Trust/Auto mode). No run recorded yet.';
    }
    const when = r.finishedAt ? timeAgo(r.finishedAt) : 'recently';
    if (r.status === 'FAILED') return `Last run failed ${when}${r.error ? ` — ${r.error}` : ''}. It retries on schedule.`;
    if (r.status === 'SKIPPED') return `Skipped ${when} — automatic matching is off in Custom mode.`;
    if (!r.total) return `Last run ${when}: nothing to retry.`;
    const parts = [
        `${r.byFile || 0} matched from file metadata`,
        `${r.bySearch || 0} auto-matched by search`,
        `${r.forAdmin || 0} left for you`,
    ];
    if (r.deferred) parts.push(`${r.deferred} deferred (API budget)`);
    return `Last run ${when}: ${parts.join(' · ')}${r.searches ? ` — ${r.searches} CV searches used` : ''}.`;
}

export default function SmartMatchPage() {
    const [unmatched, setUnmatched] = useState<any[]>([]);
    const [suggestions, setSuggestions] = useState<Record<string, any>>({});
    const [isScanning, setIsScanning] = useState(false);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const [manualMatchOpen, setManualMatchOpen] = useState(false);
    const [manualMatchTarget, setManualMatchTarget] = useState<any>(null);
    // Search-by-name is the PRIMARY manual-match flow (#199 round 2, concept by CapitanoNemo78):
    // same /api/search the request flow uses, pick a result, done. The exact-ID lookup below stays
    // as the advanced fallback for admins who already have the provider id.
    const [manualSearchQuery, setManualSearchQuery] = useState("");
    const [manualSearchResults, setManualSearchResults] = useState<any[]>([]);
    const [manualSearchPage, setManualSearchPage] = useState(1);
    const [hasMoreManualSearch, setHasMoreManualSearch] = useState(false);
    const [isManualSearching, setIsManualSearching] = useState(false);
    const [isManualSearchingMore, setIsManualSearchingMore] = useState(false);
    const [idMatchOpen, setIdMatchOpen] = useState(false);
    const [manualMatchId, setManualMatchId] = useState("");
    // Shared by both paths: set while a picked result / entered ID is resolving its full details.
    const [isManualMatching, setIsManualMatching] = useState(false);
    // #199 round 2: re-resolving the Exact Issue ID from an admin-corrected Issue Number (the auto
    // cross-reference can bind the wrong issue within an otherwise-correct series match).
    const [isReresolvingIssueId, setIsReresolvingIssueId] = useState(false);

    const [exactIssueId, setExactIssueId] = useState("");
    const [exactIssueNumber, setExactIssueNumber] = useState("");
    const [issueOverrides, setIssueOverrides] = useState<Record<string, { issueId: string, issueNumber: string, coverImageBase64?: string, coverFromArchive?: boolean }>>({});
    // #199 round 4: per-item "local evidence" (ComicInfo.xml / series.json / scan-banked row),
    // fetched lazily and cached for the session. null = fetched, nothing found.
    const [prefills, setPrefills] = useState<Record<string, any>>({});
    const prefillFetches = useRef<Record<string, Promise<any>>>({});
    // One id-assist attempt per item per session — a failed lookup falls back to normal search
    // without retry loops.
    const attemptedIdAssist = useRef<Set<string>>(new Set());

    const fetchPrefill = (item: any): Promise<any> => {
        if (!item?.folderPath) return Promise.resolve(null);
        if (item.id in prefills) return Promise.resolve(prefills[item.id]);
        if (!prefillFetches.current[item.id]) {
            prefillFetches.current[item.id] = (async () => {
                try {
                    const res = await fetch(`/api/admin/match-prefill?path=${encodeURIComponent(item.folderPath)}`);
                    const data = await res.json().catch(() => null);
                    const p = res.ok && data?.hasContent ? data.prefill : null;
                    setPrefills(prev => ({ ...prev, [item.id]: p }));
                    return p;
                } catch {
                    setPrefills(prev => ({ ...prev, [item.id]: null }));
                    return null;
                }
            })();
        }
        return prefillFetches.current[item.id];
    };
    // Issue #189 follow-up: whether picked issue covers are ALSO baked into the archive as page 0
    // on Accept (default on, remembered). One switch governs every cover picked on this page.
    const [embedIssueCovers, setEmbedIssueCovers] = useState(true);
    useEffect(() => {
        try { if (localStorage.getItem('omnibus-embed-issue-cover') === '0') setEmbedIssueCovers(false); } catch { /* private mode */ }
    }, []);
    const updateEmbedIssueCovers = (v: boolean) => {
        setEmbedIssueCovers(v);
        try { localStorage.setItem('omnibus-embed-issue-cover', v ? '1' : '0'); } catch { /* private mode */ }
    };
    const [manualMatchResult, setManualMatchResult] = useState<any>(null);
    
    // --- NEW: Multi-Select & Bulk Processing State ---
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [isBulkProcessing, setIsBulkProcessing] = useState(false);
    // Accept All progress: null = idle, otherwise {done, total} across the chunked bulk calls.
    const [acceptAllProgress, setAcceptAllProgress] = useState<{ done: number; total: number } | null>(null);
    const [isBulkManualMatch, setIsBulkManualMatch] = useState(false);
    // Guard: warn before a bulk manual match applies the same series to multiple FOLDERS (which merges them).
    const [mergeWarnOpen, setMergeWarnOpen] = useState(false);
    const [mergeWarnCount, setMergeWarnCount] = useState(0);

    const [searchProvider, setSearchProvider] = useState("COMICVINE");
    const [metronConfigured, setMetronConfigured] = useState(false);

    // --- NEW: Per-item metadata overrides (Series Group / Universe / identity) applied at match time ---
    const [metadataOverrides, setMetadataOverrides] = useState<Record<string, SmartMatchOverride>>({});
    const [metaEditorOpen, setMetaEditorOpen] = useState(false);
    const [metaEditorTarget, setMetaEditorTarget] = useState<any>(null);
    const [metaEditorSeed, setMetaEditorSeed] = useState<any>(null);
    const [folderPattern, setFolderPattern] = useState("{Publisher}/{Series} ({Year})");
    const [writeToFileDefault, setWriteToFileDefault] = useState(true);
    // Bulk Custom-ID: a shared Series Group / Universe applied to every selected item.
    const [bulkSeriesGroup, setBulkSeriesGroup] = useState("");
    const [bulkUniverse, setBulkUniverse] = useState("");

    // --- Page Manager (issue #189): exploded page view + removal, single card or multi-select ---
    const [pageManagerOpen, setPageManagerOpen] = useState(false);
    const [pageManagerQueue, setPageManagerQueue] = useState<PageManagerTarget[]>([]);
    const [pageManagerLoading, setPageManagerLoading] = useState(false);
    // Large multi-selections get a count warning before opening the sequential walker.
    const [pendingPageQueue, setPendingPageQueue] = useState<PageManagerTarget[] | null>(null);

    // Resolves matcher cards (series folders or loose files) to their FILE-BACKED issue rows —
    // the Page Manager needs issue ids for the progress/bookmark fixups, so pre-import loose
    // files (no DB row yet) are skipped with a note.
    const expandCardsToPageTargets = async (cards: any[]): Promise<PageManagerTarget[]> => {
        const targets: PageManagerTarget[] = [];
        for (const card of cards) {
            try {
                const res = await fetch(`/api/library/series?path=${encodeURIComponent(card.folderPath)}`);
                if (!res.ok) continue;
                const data = await res.json();
                const issues = Array.isArray(data.downloadedIssues) ? data.downloadedIssues : [];
                for (const iss of issues) {
                    if (!iss.id || !iss.fullPath) continue;
                    const num = iss.parsedNum != null ? iss.parsedNum : (iss.number || '?');
                    targets.push({ issueId: iss.id, filePath: iss.fullPath, label: `${data.seriesName || card.name} #${num}` });
                }
            } catch { /* card resolves to nothing — skipped */ }
        }
        return targets;
    };

    const openPageManager = async (cards: any[]) => {
        setPageManagerLoading(true);
        try {
            const targets = await expandCardsToPageTargets(cards);
            if (targets.length === 0) {
                toast({ title: "No manageable files", description: "These items have no imported issues yet — page management is available once a file is in the library.", variant: "destructive" });
                return;
            }
            if (targets.length > 12) {
                setPendingPageQueue(targets); // confirm the walk first
                return;
            }
            setPageManagerQueue(targets);
            setPageManagerOpen(true);
        } finally {
            setPageManagerLoading(false);
        }
    };

    // --- Page preview: flip through an unmatched file's pages to identify it before matching ---
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewTarget, setPreviewTarget] = useState<any>(null);
    const [previewFile, setPreviewFile] = useState<string | null>(null);
    const [previewCount, setPreviewCount] = useState(0);
    const [previewIndex, setPreviewIndex] = useState(0);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    // RAR-family archives can't be page-listed (zip-only) — fall back to the single-page archive cover.
    const previewIsRar = !!previewFile && /\.(cbr|rar|cb7)$/i.test(previewFile) && previewCount === 0;

    const openPreview = async (series: any) => {
        setPreviewTarget(series);
        setPreviewOpen(true);
        setPreviewLoading(true);
        setPreviewError(null);
        setPreviewFile(null);
        setPreviewCount(0);
        setPreviewIndex(0);
        try {
            const res = await fetch(`/api/library/archive-preview?path=${encodeURIComponent(series.folderPath)}&info=1`);
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Preview unavailable');
            }
            const data = await res.json();
            if (!data.file) {
                setPreviewError('No comic archive found in this folder.');
                return;
            }
            setPreviewFile(data.file);
            setPreviewCount(data.pageCount || 0);
            if (!data.pageCount && !/\.(cbr|rar|cb7)$/i.test(data.file)) {
                setPreviewError('No readable pages found in this archive.');
            }
        } catch (e: any) {
            setPreviewError(e.message || 'Preview unavailable');
        } finally {
            setPreviewLoading(false);
        }
    };

    const { toast } = useToast();

    // --- Background sweep status (discussion #177): what the scheduled retry sweep did last ---
    const [sweepInfo, setSweepInfo] = useState<any>(null);
    const [sweepQueued, setSweepQueued] = useState(false);
    const sweepPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchSweepInfo = async (): Promise<any | null> => {
        try {
            const res = await fetch('/api/admin/sweep', { cache: 'no-store' });
            if (!res.ok) return null;
            const data = await res.json();
            setSweepInfo(data);
            return data;
        } catch {
            return null;
        }
    };

    // Silent re-fetch of the unmatched list (no loading spinner) after a sweep run matches items.
    const reloadUnmatched = async () => {
        try {
            const res = await fetch(`/api/admin/unmatched?_t=${Date.now()}`, { cache: 'no-store' });
            const data = await res.json();
            if (res.ok && Array.isArray(data)) setUnmatched(data);
        } catch {}
    };

    useEffect(() => {
        fetchSweepInfo();
        return () => { if (sweepPollRef.current) clearInterval(sweepPollRef.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const runSweepNow = async () => {
        setSweepQueued(true);
        const prevFinished = sweepInfo?.lastResult?.finishedAt || 0;
        try {
            const res = await fetch('/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job: 'unmatched_sweep' })
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to queue the sweep.');
            }
            toast({ title: "Sweep queued", description: "Running in the background — results appear here when it finishes." });
            // Poll for the new result. The sweep paces CV searches ~2s apart, so a run can take
            // minutes; give up after 10 minutes and let the card refresh on the next visit.
            let ticks = 0;
            if (sweepPollRef.current) clearInterval(sweepPollRef.current);
            sweepPollRef.current = setInterval(async () => {
                ticks += 1;
                const data = await fetchSweepInfo();
                const finished = data?.lastResult?.finishedAt || 0;
                if (finished > prevFinished || ticks >= 60) {
                    if (sweepPollRef.current) { clearInterval(sweepPollRef.current); sweepPollRef.current = null; }
                    setSweepQueued(false);
                    if (finished > prevFinished) reloadUnmatched();
                }
            }, 10000);
        } catch (e: unknown) {
            setSweepQueued(false);
            toast({ title: "Couldn't queue the sweep", description: getErrorMessage(e), variant: "destructive" });
        }
    };

    useEffect(() => {
        fetch('/api/admin/config')
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.settings) {
                    const mUser = data.settings.find((s: any) => s.key === 'metron_user')?.value;
                    const mPass = data.settings.find((s: any) => s.key === 'metron_pass')?.value;
                    const primary = data.settings.find((s: any) => s.key === 'primary_metadata_source')?.value;
                    const pattern = data.settings.find((s: any) => s.key === 'folder_naming_pattern')?.value;
                    const writeDefault = data.settings.find((s: any) => s.key === 'metadata_write_comicinfo')?.value;
                    if (mUser && mPass) setMetronConfigured(true);
                    if (primary) setSearchProvider(primary);
                    if (pattern) setFolderPattern(pattern);
                    setWriteToFileDefault(writeDefault !== 'false');
                }
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        document.title = "Omnibus - Smart Matcher";
        
        fetch(`/api/admin/unmatched?_t=${Date.now()}`, { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                
                Logger.log(`SMART MATCHER RESPONSE: ${JSON.stringify(data)}`, 'info');

                if (!res.ok) {
                    toast({ title: "API Error", description: data.error || "Failed to fetch.", variant: "destructive" });
                }

                if (Array.isArray(data)) {
                    setUnmatched(data);
                } else if (data && data.error) {
                    Logger.log(`Backend returned an error: ${getErrorMessage(data.error)}`, 'error');
                }
                
                setLoading(false);
            })
            .catch((err) => {
                Logger.log(`Fetch failed entirely: ${getErrorMessage(err)}`, 'error');
                setLoading(false);
            });
    }, [toast]);

    // Which provider the live `suggestions` belong to. The persist effect writes under this ref (not
    // the latest searchProvider) so a provider switch — which re-hydrates suggestions on the next
    // render — can't momentarily clobber the other provider's cache with stale data.
    const suggestionsProviderRef = useRef<string>('COMICVINE');

    // Hydrate cached suggestions whenever the active provider changes (incl. the initial settle from
    // saved config). Stale entries for series no longer unmatched simply don't render and age out by TTL.
    useEffect(() => {
        suggestionsProviderRef.current = searchProvider;
        setSuggestions(readScanCache(searchProvider));
    }, [searchProvider]);

    // Persist live suggestions under the provider they belong to.
    useEffect(() => {
        writeScanCache(suggestionsProviderRef.current, suggestions);
    }, [suggestions]);

    const startSmartScan = async () => {
        setIsScanning(true);
        let matchCount = 0;

        for (const series of unmatched) {
            if (suggestions[series.id]) continue; 

            try {
                let cleanName = series.name.replace(/(omnibus|tpb|compendium|vol\.|volume)\s*\d*/i, '').trim();
                
                if (cleanName.length < 2) {
                    cleanName = series.name.trim();
                }

                const query = `${cleanName} ${series.year > 0 ? series.year : ''}`.trim();
                
                Logger.log(`[Smart Match Debug] Auto-scanning for "${query}" using provider: ${searchProvider}`, 'debug');

                const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&provider=${searchProvider}`);
                
                if (res.status === 429) {
                    throw new Error("FATAL_RATE_LIMIT");
                }

                const data = await res.json();

                if (data.results && data.results.length > 0) {
                    setSuggestions(prev => ({ ...prev, [series.id]: data.results[0] }));
                    matchCount++;
                } else {
                    setSuggestions(prev => ({ ...prev, [series.id]: 'NOT_FOUND' }));
                }
            } catch (e: any) {
                setSuggestions(prev => ({ ...prev, [series.id]: 'ERROR' }));

                if (e.message === "FATAL_RATE_LIMIT" || e.message?.includes("429")) {
                    toast({ 
                        title: "Rate Limit Exceeded", 
                        description: "Omnibus has hit the API limits. Pausing the smart scan to protect your connection. Please attempt the scan again later to continue.", 
                        variant: "destructive" 
                    });
                    break;
                }
            }

            await new Promise(r => setTimeout(r, 1500));
        }

        setIsScanning(false);
        toast({ title: "Scan Complete", description: `Found suggestions for ${matchCount} series.` });
    };

    // The exact single-accept payload, shared by the per-row accept, Accept Selected, and Accept
    // All — so every path carries the same admin overrides and issue-exact fields. Async since
    // #199 round 4 Beta B: keep-mode reads the item's local evidence at Accept time so curation
    // carries (and locks) even when the admin never opened the editor.
    const buildMatchPayload = async (series: any, suggestion: any) => {
        const issueOv = issueOverrides[series.id] || {};
        const meta = metadataOverrides[series.id];
        const dataMode = meta?.dataMode ?? 'keep';
        // Keep-mode auto-carry: no saved override → the files' CONTENT fields still land and lock.
        // A saved override supersedes it entirely (the dialog seeded from the same prefill, so the
        // admin's save already contains the files' values plus their edits). Replace mode never
        // carries file data — that's its meaning.
        const prefill = (!meta && dataMode === 'keep') ? await fetchPrefill(series).catch(() => null) : null;
        const keepCarry = prefill ? buildKeepCarry(prefill) : null;
        const issueTitle = series.isRawFile
            ? (meta?.issueTitle ?? (dataMode === 'keep' ? (prefill?.issue?.title ?? undefined) : undefined))
            : undefined;
        return {
            oldFolderPath: series.folderPath,
            cvId: suggestion.id,
            metadataId: suggestion.id,
            metadataSource: suggestion.metadataSource || 'COMICVINE',
            // Admin metadata overrides (Edit Metadata) win over the suggestion's values.
            name: meta?.name || suggestion.name,
            year: meta?.year || suggestion.year,
            publisher: meta?.publisher || suggestion.publisher,
            ...(meta ? {
                universe: meta.universe || undefined,
                seriesGroup: meta.seriesGroup || undefined,
                description: meta.description || undefined,
                coverImageBase64: meta.coverImageBase64 || undefined,
                writeToFile: meta.writeToFile,
                lockMetadata: true,
                // #199 ComicInfo defaults (Credits/Story & Tags/Details tabs) — series-wide values
                // embedded into every issue's ComicInfo.xml. Strings keep the undefined-means-
                // untouched contract (same as universe above)…
                ...Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, meta[k] || undefined])),
                // …but the B&W switch is two-way by design: false clears a mistaken Yes back to
                // unset (the route stores null, never a false "No" claim).
                blackAndWhite: !!meta.blackAndWhite,
            } : (keepCarry ?? {})),
            dataMode,
            ...(issueTitle ? { issueTitle } : {}),
            exactIssueId: issueOv.issueId || undefined,
            exactIssueNumber: issueOv.issueNumber || undefined,
            issueCoverImageBase64: issueOv.coverImageBase64 || undefined,
            // Issue #189 follow-up: bake the cover into the archive as page 0 (engine insert-only) —
            // genuine uploads only; the comic's own art is already in there (#199 duplicate guard).
            issueCoverEmbed: shouldEmbedIssueCover(issueOv, embedIssueCovers)
        };
    };

    const handleAcceptMatch = async (series: any, suggestion: any) => {
        setProcessingId(series.id);
        try {
            Logger.log(`[Smart Match Debug] Accepting match for "${series.name}". Linking to ${suggestion.metadataSource || 'COMICVINE'} ID: ${suggestion.id}`, 'debug');

            const res = await fetch('/api/library/match-series', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(await buildMatchPayload(series, suggestion))
            });

            if (res.ok) {
                const result = await res.json().catch(() => ({}));
                if (result.conflicts > 0) {
                    toast({ title: "Matched with conflicts", description: `${suggestion.name} was linked, but ${result.conflicts} duplicate file(s) were left in place (not overwritten). Check the logs.`, variant: "destructive" });
                } else {
                    toast({ title: "Matched Successfully!", description: `${suggestion.name} has been linked and organized.` });
                }
                setUnmatched(prev => prev.filter(s => s.id !== series.id));
                return true;
            } else {
                const err = await res.json();
                toast({ title: "Match Failed", description: err.error, variant: "destructive" });
                return false;
            }
        } catch (e) {
            toast({ title: "Error", variant: "destructive" });
            return false;
        } finally {
            setProcessingId(null);
        }
    };

    const handleBulkAccept = async () => {
        setIsBulkProcessing(true);
        let successCount = 0;
        const failedItems = [];

        for (const id of Array.from(selectedItems)) {
            const series = unmatched.find(s => s.id === id);
            const suggestion = suggestions[id];
            
            if (series && suggestion && suggestion !== 'NOT_FOUND' && suggestion !== 'ERROR') {
                const success = await handleAcceptMatch(series, suggestion);
                if (success) {
                    successCount++;
                } else {
                    failedItems.push(series.name);
                }
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        setIsBulkProcessing(false);

        if (failedItems.length > 0) {
            toast({ title: "Bulk Match Completed with Errors", description: `Matched ${successCount}. Failed: ${failedItems.length}`, variant: "destructive" });
        } else if (successCount > 0) {
            toast({ title: "Bulk Match Complete", description: `Successfully matched ${successCount} items.` });
            setSelectedItems(new Set());
            setIsSelectionMode(false);
        }
    };

    // Accept All (2026-07-25 worklist item 4): one click accepts every suggestion the auto-scan
    // produced. Server-side bulk accepts in chunks of 5 — each accept costs a provider fetch plus a
    // folder move, and one giant request would blow past reverse-proxy/tunnel response ceilings —
    // with per-chunk UI progress. Failures stay in the list with their errors; successes leave it.
    const ACCEPT_ALL_CHUNK = 5;
    const acceptableSeries = unmatched.filter(s => {
        const g = suggestions[s.id];
        return g && g !== 'NOT_FOUND' && g !== 'ERROR';
    });

    const handleAcceptAll = async () => {
        const targets = acceptableSeries;
        if (targets.length === 0) return;
        setAcceptAllProgress({ done: 0, total: targets.length });
        let successCount = 0;
        const failedItems: string[] = [];

        try {
            for (let i = 0; i < targets.length; i += ACCEPT_ALL_CHUNK) {
                const chunk = targets.slice(i, i + ACCEPT_ALL_CHUNK);
                let results: Array<{ ok: boolean; error?: string }> = [];
                try {
                    const res = await fetch('/api/library/match-series/bulk', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items: await Promise.all(chunk.map(s => buildMatchPayload(s, suggestions[s.id]))) })
                    });
                    const data = await res.json().catch(() => ({}));
                    results = res.ok && Array.isArray(data.results)
                        ? data.results
                        : chunk.map(() => ({ ok: false, error: data.error || `HTTP ${res.status}` }));
                } catch (e: any) {
                    results = chunk.map(() => ({ ok: false, error: e?.message || 'Network error' }));
                }

                const succeededIds = new Set(chunk.filter((_, idx) => results[idx]?.ok).map(s => s.id));
                chunk.forEach((s, idx) => {
                    if (results[idx]?.ok) successCount++;
                    else failedItems.push(`${s.name}${results[idx]?.error ? ` (${results[idx].error})` : ''}`);
                });
                if (succeededIds.size > 0) {
                    setUnmatched(prev => prev.filter(s => !succeededIds.has(s.id)));
                }
                setAcceptAllProgress({ done: Math.min(i + chunk.length, targets.length), total: targets.length });
            }
        } finally {
            setAcceptAllProgress(null);
        }

        if (failedItems.length > 0) {
            toast({
                title: "Accept All finished with errors",
                description: `Matched ${successCount} of ${targets.length}. Failed: ${failedItems.slice(0, 3).join('; ')}${failedItems.length > 3 ? ` and ${failedItems.length - 3} more` : ''}`,
                variant: "destructive"
            });
        } else {
            toast({ title: "Accept All complete", description: `Successfully matched all ${successCount} suggested series.` });
        }
    };

    // Both manual-match paths (name search pick + exact-ID lookup) resolve here: fetch the volume's
    // full details, store the suggestion, and cross-reference extracted issue numbers into exact
    // provider issue IDs for the Issue Mapping section.
    const resolveVolumeSelection = async (volumeId: string, provider: string) => {
        setIsManualMatching(true);
        try {
            const res = await fetch(`/api/issue-details?id=${volumeId}&type=volume&provider=${provider}`);
            const data = await res.json();

            if (res.ok && data && !data.error) {
                const suggestionData = buildManualSuggestion(data, provider);

                // Show preview instead of closing modal
                setManualMatchResult(suggestionData);

                // AUTO-MAP: Extract issue numbers and match IDs
                const newOverrides = { ...issueOverrides };
                const itemsToMap = isBulkManualMatch ? Array.from(selectedItems) : (manualMatchTarget ? [manualMatchTarget.id] : []);

                itemsToMap.forEach(id => {
                    const item = unmatched.find(s => s.id === id);
                    if (item?.isRawFile) {
                        const extractedNum = extractIssueNumber(item.name);
                        const matchedIssueId = findIssueIdByNumber(suggestionData.rawIssues, extractedNum);

                        // Merge instead of replace: a cover already picked for this item (and its
                        // .010 provenance flag) must survive re-resolving the series match.
                        newOverrides[id] = { ...newOverrides[id], issueNumber: extractedNum, issueId: matchedIssueId };

                        // Update individual states for single-match mode
                        if (!isBulkManualMatch) {
                            setExactIssueNumber(extractedNum);
                            setExactIssueId(matchedIssueId);
                        }
                    }
                });

                setIssueOverrides(newOverrides);
                toast({ title: "Series Selected", description: "Review the metadata and issue mappings, then click Apply Match." });
                return suggestionData;

            } else {
                throw new Error(data.error || "Couldn't load series details");
            }
        } catch (e: any) {
            toast({ title: "Lookup Failed", description: e.message, variant: "destructive" });
            return null;
        } finally {
            setIsManualMatching(false);
        }
    };

    // #199 round 4 id-assist: when the Search Match dialog opens for an item whose FILES carry a
    // provider id (ComicInfo tags/Web/Notes, or series.json's comicid), jump straight to the exact
    // lookup — the admin lands on the resolved series with the mapping (and, for a tagged loose
    // file, the exact issue binding) already in place. Best-effort: any failure just leaves the
    // normal search UI. One attempt per item; file evidence outranks the filename automap.
    useEffect(() => {
        const t = manualMatchTarget;
        if (!manualMatchOpen || !t || manualMatchResult || isManualMatching || isBulkManualMatch) return;
        const p = prefills[t.id];
        if (!p?.ids || attemptedIdAssist.current.has(t.id)) return;
        const volId = p.ids.cvVolumeId || p.ids.metronSeriesId;
        const volProvider = p.ids.cvVolumeId ? 'COMICVINE' : 'METRON';
        const issueId = p.ids.cvIssueId || p.ids.metronIssueId;
        const issueProvider = p.ids.cvIssueId ? 'COMICVINE' : 'METRON';
        if (!volId && !issueId) return;
        attemptedIdAssist.current.add(t.id);
        (async () => {
            try {
                let vid = volId ? String(volId) : '';
                let provider = volId ? volProvider : issueProvider;
                if (!vid && issueId) {
                    // Only an issue id — one detail call resolves its volume, then the normal path runs.
                    const r = await fetch(`/api/issue-details?id=${issueId}&type=issue&provider=${issueProvider}`);
                    const d = await r.json().catch(() => null);
                    if (r.ok && d?.volumeId) vid = String(d.volumeId);
                }
                if (!vid) return;
                const result = await resolveVolumeSelection(vid, provider);
                if (!result) return;
                if (t.isRawFile) {
                    const fileNum = (p.issue?.number || '').trim();
                    const boundId = issueId ? String(issueId) : (fileNum ? findIssueIdByNumber(result.rawIssues, fileNum) : '');
                    if (fileNum || boundId) {
                        setIssueOverrides(prev => ({
                            ...prev,
                            [t.id]: {
                                ...prev[t.id],
                                issueNumber: fileNum || prev[t.id]?.issueNumber || '',
                                issueId: boundId || prev[t.id]?.issueId || '',
                            }
                        }));
                        if (fileNum) setExactIssueNumber(fileNum);
                        if (boundId) setExactIssueId(boundId);
                    }
                }
                toast({
                    title: "Matched from your files",
                    description: `${result.name} — resolved from the ${p.ids.cvVolumeId || p.ids.cvIssueId ? 'ComicVine' : 'Metron'} id in this item's own metadata. Verify and Apply.`,
                });
            } catch { /* best-effort: the search UI is still right there */ }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manualMatchOpen, manualMatchTarget, manualMatchResult, isManualMatching, isBulkManualMatch, prefills]);

    // PRIMARY: search the provider by series name — the same endpoint Fix Match and the request
    // flow already use — and let the admin pick from a list instead of hunting provider IDs.
    const handleManualSearch = async (loadMore = false) => {
        if (manualSearchQuery.trim().length < 2) return;
        const nextPage = loadMore ? manualSearchPage + 1 : 1;
        if (!loadMore) { setIsManualSearching(true); setManualMatchResult(null); }
        else setIsManualSearchingMore(true);

        try {
            Logger.log(`[Smart Match Debug] Manual search initiated for "${manualSearchQuery}" via ${searchProvider}`, 'debug');

            const res = await fetch(`/api/search?q=${encodeURIComponent(manualSearchQuery)}&page=${nextPage}&provider=${searchProvider}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Search failed");

            setManualSearchResults(prev => loadMore ? [...prev, ...(data.results || [])] : (data.results || []));
            setHasMoreManualSearch(!!data.hasMore);
            setManualSearchPage(nextPage);

            if (!loadMore && (!data.results || data.results.length === 0)) {
                toast({ title: "No results", description: `No series found for "${manualSearchQuery}". Try another spelling, or match by exact ID below.` });
            }
        } catch (e: any) {
            toast({ title: "Search Failed", description: e.message, variant: "destructive" });
        } finally {
            setIsManualSearching(false);
            setIsManualSearchingMore(false);
        }
    };

    // A result row was picked — resolve it under ITS OWN provider (results keep their source, so a
    // list searched on one provider stays selectable after the source dropdown changes).
    const handleSelectSearchResult = (item: any) => {
        if (isManualMatching) return;
        resolveVolumeSelection(String(item.id), item.metadataSource || searchProvider);
    };

    // #199 round 2: the admin corrected the Issue Number (right series, wrong issue bound) — look
    // the exact issue ID back up from that number. The picked result's rawIssues are authoritative
    // when present; an auto-scan-sourced match (no list) falls back to one volume-details fetch.
    const handleReresolveIssueId = async () => {
        if (!manualMatchTarget || !manualMatchResult) return;
        const rawNumber = issueOverrides[manualMatchTarget.id]?.issueNumber ?? exactIssueNumber;
        if (!rawNumber || !rawNumber.trim()) {
            toast({ title: "Enter the issue number first", description: "Refresh looks up the exact issue using this number.", variant: "destructive" });
            return;
        }
        setIsReresolvingIssueId(true);
        try {
            const newId = await resolveIssueIdByNumber({
                issueNumber: rawNumber,
                rawIssues: manualMatchResult.rawIssues,
                seriesMetadataId: manualMatchResult.id,
                provider: manualMatchResult.metadataSource || searchProvider,
            });
            if (!newId) {
                toast({ title: "No matching issue found", description: `Couldn't find issue #${rawNumber} for this series on the provider.`, variant: "destructive" });
                return;
            }
            setExactIssueId(newId);
            setIssueOverrides(prev => ({ ...prev, [manualMatchTarget.id]: { ...prev[manualMatchTarget.id], issueId: newId } }));
            toast({ title: "Issue ID updated", description: `Re-matched to issue #${rawNumber}.` });
        } catch (e: any) {
            toast({ title: "Couldn't re-resolve", description: e.message, variant: "destructive" });
        } finally {
            setIsReresolvingIssueId(false);
        }
    };

    // ADVANCED fallback: the classic exact-provider-ID lookup, for admins who already have the id.
    const handleManualLookup = async () => {
        const cleanId = cleanProviderId(manualMatchId);
        if (!cleanId) {
            toast({ title: "Lookup Failed", description: "Invalid ID format", variant: "destructive" });
            return;
        }
        Logger.log(`[Smart Match Debug] Manual lookup initiated for ID: ${cleanId} via ${searchProvider}`, 'debug');
        setManualMatchResult(null); // Reset previous searches
        await resolveVolumeSelection(cleanId, searchProvider);
    };

    // Applying ONE manual match to multiple FOLDERS assigns them all the same series, which merges them into
    // a single series (match-series collapses duplicate metadataId). Warn first. Loose-file selections
    // (issues of one series, auto-mapped during lookup) are the intended bulk use and don't trigger it.
    const handleApplyManualMatch = () => {
        if (!manualMatchResult) return;
        if (isBulkManualMatch) {
            const folderCount = Array.from(selectedItems).filter(id => {
                const it = unmatched.find(s => s.id === id);
                return it && !it.isRawFile;
            }).length;
            if (folderCount > 1) {
                setMergeWarnCount(folderCount);
                setMergeWarnOpen(true);
                return;
            }
        }
        doApplyManualMatch();
    };

    const doApplyManualMatch = () => {
        if (!manualMatchResult) return;

        if (isBulkManualMatch) {
            setSuggestions(prev => {
                const next = { ...prev };
                selectedItems.forEach(id => { next[id] = manualMatchResult; });
                return next;
            });
            // Apply the shared Series Group / Universe (when entered) to every selected item, so a set
            // of related series can be grouped under one umbrella folder in a single pass.
            const sg = bulkSeriesGroup.trim();
            const uni = bulkUniverse.trim();
            if (sg || uni) {
                setMetadataOverrides(prev => {
                    const next = { ...prev };
                    selectedItems.forEach(id => {
                        next[id] = {
                            ...next[id],
                            name: next[id]?.name || manualMatchResult.name,
                            year: next[id]?.year || (manualMatchResult.year != null ? String(manualMatchResult.year) : ""),
                            publisher: next[id]?.publisher || manualMatchResult.publisher,
                            seriesGroup: sg || next[id]?.seriesGroup || "",
                            universe: uni || next[id]?.universe || "",
                            writeToFile: next[id]?.writeToFile ?? writeToFileDefault,
                            locked: true,
                        };
                    });
                    return next;
                });
            }
            toast({ title: "Match Applied", description: (sg || uni) ? "Matches + metadata set for selected items. Click 'Accept Selected' to save." : "Matches set for selected items. Click 'Accept Selected' to confirm and save." });
        } else if (manualMatchTarget) {
            setSuggestions(prev => ({
                ...prev,
                [manualMatchTarget.id]: manualMatchResult
            }));
            toast({ title: "Match Found", description: "You can now accept the manual match." });
        }

        setManualMatchOpen(false);
        setManualMatchResult(null);
        setIsBulkManualMatch(false);
        setBulkSeriesGroup("");
        setBulkUniverse("");
    };

    const handleDismiss = (id: string) => {
        setUnmatched(prev => prev.filter(s => s.id !== id));
    };

    const toggleSelection = (id: string) => {
        setSelectedItems(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Open the per-item metadata editor, seeding from the item's current suggestion / lookup result.
    // Awaits the item's file-side prefill first (#199 round 4) so the dialog opens with the
    // library's own metadata already in the fields — a local read, so the wait is imperceptible.
    const openMetaEditor = async (target: any, seedSource: any) => {
        await fetchPrefill(target).catch(() => null);
        setMetaEditorTarget(target);
        setMetaEditorSeed(seedSource ? {
            name: seedSource.name,
            year: seedSource.year,
            publisher: seedSource.publisher,
            description: seedSource.description,
            image: seedSource.image,
            // #199 round 2: carried so the dialog's own "Refresh from number" can re-resolve this
            // issue's exact provider ID without a Search Match round-trip.
            metadataId: seedSource.id,
            metadataSource: seedSource.metadataSource || searchProvider,
            // #199 round 4: the volume's aggregated credits ride the seed so the dialog's
            // "fill empty fields from provider" always uses THIS item's match, never a stale one.
            credits: seedSource.credits,
        } : null);
        setMetaEditorOpen(true);
    };

    const handleMetaSave = (override: SmartMatchOverride) => {
        if (!metaEditorTarget) return;
        const target = metaEditorTarget;
        setMetadataOverrides(prev => ({ ...prev, [target.id]: override }));
        // For a loose file (one issue), keep the issue cover in the issue-override store so it flows to
        // match-series and stays in sync with the Custom-ID Issue Mapping picker.
        if (target.isRawFile) {
            setIssueOverrides(prev => ({
                ...prev,
                [target.id]: {
                    issueNumber: prev[target.id]?.issueNumber || "",
                    issueId: prev[target.id]?.issueId || "",
                    coverImageBase64: override.issueCoverImageBase64,
                    // #199: archive-sourced covers are display-only — Accept must never embed them.
                    coverFromArchive: override.issueCoverFromArchive,
                }
            }));
        }
        toast({ title: "Details saved", description: "Applied when you accept this match." });
    };

    // Read a per-issue cover image into the item's override (applied to that issue on Accept).
    const handleIssueCoverPick = (id: string, file: File | undefined) => {
        if (!file) return;
        if (file.size > 15 * 1024 * 1024) {
            toast({ title: "Image too large", description: "Choose an image under 15MB.", variant: "destructive" });
            return;
        }
        const reader = new FileReader();
        reader.onload = () => setIssueOverrides(prev => ({
            ...prev,
            [id]: { issueNumber: prev[id]?.issueNumber || "", issueId: prev[id]?.issueId || "", coverImageBase64: reader.result as string }
        }));
        reader.onerror = () => toast({ title: "Couldn't read image", variant: "destructive" });
        reader.readAsDataURL(file);
    };

    if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

    return (
        <div className="container mx-auto max-w-5xl py-10 px-6 transition-colors duration-300">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-8 gap-6">
                <div className="flex items-start gap-4 flex-1">
                    <Button variant="ghost" size="icon" className="shrink-0 mt-1 text-muted-foreground hover:bg-muted hover:text-foreground" asChild>
                        <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
                    </Button>
                    <div>
                        <h1 className="text-3xl font-extrabold flex items-center gap-3 text-foreground">
                            <Sparkles className="w-8 h-8 text-primary shrink-0" />
                            Smart Matcher
                        </h1>
                        <p className="text-muted-foreground mt-1 leading-relaxed">
                            You have {unmatched.length} unmatched files/folders. Let AI find the metadata for you.
                        </p>
                    </div>
                </div>
                
                <div className="flex flex-col sm:flex-row flex-wrap gap-3 w-full lg:w-auto shrink-0 items-stretch sm:items-center">
                    <Button 
                        variant={isSelectionMode ? "secondary" : "outline"} 
                        onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedItems(new Set()); }} 
                        className={`h-12 w-full sm:w-auto font-bold flex-1 sm:flex-none ${isSelectionMode ? "bg-primary/20 text-primary hover:bg-primary/30 border-primary/50" : "border-border"}`}
                    >
                        {isSelectionMode ? <Square className="w-4 h-4 mr-2 shrink-0" /> : <CheckSquare className="w-4 h-4 mr-2 shrink-0" />}
                        <span className="whitespace-nowrap">{isSelectionMode ? "Cancel Select" : "Select"}</span>
                    </Button>

                    {metronConfigured && (
                        <div className="w-full sm:w-[150px] flex-1 sm:flex-none">
                            <Select value={searchProvider} onValueChange={setSearchProvider}>
                                <SelectTrigger className="w-full bg-background border-border h-12 shadow-sm font-bold text-foreground">
                                    <SelectValue placeholder="Source" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="COMICVINE">ComicVine</SelectItem>
                                    <SelectItem value="METRON">Metron.Cloud</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    
                    <Button onClick={startSmartScan} disabled={isScanning || unmatched.length === 0} className="h-12 w-full sm:w-auto flex-1 sm:flex-none bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-6 shadow-lg border-0">
                        {isScanning ? <><Loader2 className="w-5 h-5 mr-2 animate-spin shrink-0" /> <span className="whitespace-nowrap">Scanning...</span></> : <><FolderSearch className="w-5 h-5 mr-2 shrink-0" /> <span className="whitespace-nowrap">Start Auto-Scan</span></>}
                    </Button>

                    <Button
                        onClick={handleAcceptAll}
                        disabled={isScanning || isBulkProcessing || acceptAllProgress !== null || acceptableSeries.length === 0}
                        title="Accept every suggestion the auto-scan produced (rows without a suggestion are skipped)"
                        className="h-12 w-full sm:w-auto flex-1 sm:flex-none bg-green-600 hover:bg-green-700 text-white font-bold px-6 shadow-lg border-0"
                    >
                        {acceptAllProgress
                            ? <><Loader2 className="w-5 h-5 mr-2 animate-spin shrink-0" /> <span className="whitespace-nowrap">Accepting {acceptAllProgress.done}/{acceptAllProgress.total}...</span></>
                            : <><CheckCheck className="w-5 h-5 mr-2 shrink-0" /> <span className="whitespace-nowrap">Accept All ({acceptableSeries.length})</span></>}
                    </Button>
                </div>
            </div>

            {/* Provider quicklinks used to live here — Search Match made ID-hunting the exception,
                so the ComicVine/Metron links moved into the dialog's exact-ID section. */}

            {/* BACKGROUND SWEEP STATUS (discussion #177) */}
            {sweepInfo && (
                <Card className="mt-6 p-4 border-border bg-muted/30">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="p-2.5 bg-primary/10 rounded-lg shrink-0">
                                <History className="w-5 h-5 text-primary" />
                            </div>
                            <div className="min-w-0">
                                <div className="font-bold text-foreground flex items-center gap-2 flex-wrap">
                                    Background Sweep
                                    <span className="text-[10px] font-bold uppercase tracking-wider bg-muted px-2 py-0.5 rounded-md text-muted-foreground">
                                        every {sweepInfo.scheduleHours}h · {sweepInfo.matcherMode} mode
                                    </span>
                                </div>
                                <p className={`text-sm mt-0.5 ${sweepInfo.lastResult?.status === 'FAILED' ? 'text-red-500' : 'text-muted-foreground'}`}>
                                    {describeSweep(sweepInfo)}
                                </p>
                            </div>
                        </div>
                        <Button variant="outline" onClick={runSweepNow} disabled={sweepQueued} className="shrink-0 font-bold border-border">
                            {sweepQueued
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin shrink-0" /> <span className="whitespace-nowrap">Sweeping...</span></>
                                : <><RefreshCw className="w-4 h-4 mr-2 shrink-0" /> <span className="whitespace-nowrap">Run Sweep Now</span></>}
                        </Button>
                    </div>
                </Card>
            )}

            {unmatched.length === 0 ? (
                <div className="text-center py-20 border-2 border-dashed rounded-xl border-border bg-muted/30">
                    <Check className="w-12 h-12 mx-auto text-green-500 mb-3" />
                    <h3 className="text-lg font-bold text-foreground">All Caught Up!</h3>
                    <p className="text-muted-foreground mt-1">Every file in your library has a valid external ID.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-4 pb-20 mt-6">
                    {unmatched.map((series) => {
                        const suggestion = suggestions[series.id];
                        const isProcessing = processingId === series.id;
                        const isSelected = selectedItems.has(series.id);
                        const providerLabel = suggestion?.metadataSource === 'METRON' ? 'Metron' : (suggestion?.metadataSource === 'COMICVINE' ? 'ComicVine' : (searchProvider === 'METRON' ? 'Metron' : 'ComicVine'));

                        return (
                            <Card 
                                key={series.id} 
                                className={`p-4 flex flex-col md:flex-row items-center gap-6 transition-all border-border bg-background ${isProcessing ? 'opacity-50 pointer-events-none' : ''} ${isSelectionMode && isSelected ? 'ring-2 ring-primary border-primary bg-primary/5' : ''} ${isSelectionMode ? 'cursor-pointer hover:border-primary/50' : ''}`}
                                onClick={() => isSelectionMode && toggleSelection(series.id)}
                            >
                                {/* --- NEW: Checkbox --- */}
                                {isSelectionMode && (
                                    <div className="shrink-0 pr-2 md:pr-0">
                                        <div className="bg-black/50 backdrop-blur-sm rounded p-1 pointer-events-none md:bg-transparent md:p-0">
                                            {isSelected ? <CheckSquare className="w-5 h-5 text-primary" /> : <Square className="w-5 h-5 text-muted-foreground" />}
                                        </div>
                                    </div>
                                )}

                                {/* LOCAL FOLDER/FILE DATA */}
                                <div className="flex-1 min-w-[200px] w-full md:w-auto">
                                    <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2">
                                        <span>{series.isRawFile ? 'Loose File' : 'Local Folder'}</span>
                                        {series.isRawFile && (
                                            <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-md font-bold text-[10px]">
                                                Detected Issue: #{issueOverrides[series.id]?.issueNumber || extractIssueNumber(series.name)}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-start gap-3">
                                        <div className="p-3 bg-muted rounded-lg shrink-0">
                                            {series.isRawFile ? <FileText className="w-6 h-6 text-muted-foreground" /> : <FolderSearch className="w-6 h-6 text-muted-foreground" />}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <h3 className="font-bold text-foreground break-words whitespace-normal leading-tight">{series.name}</h3>
                                            <p className="text-sm text-muted-foreground break-all whitespace-normal mt-1">{series.folderPath}</p>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="mt-1.5 h-7 px-2 -ml-2 text-primary hover:bg-primary/10 font-bold"
                                                disabled={isSelectionMode}
                                                onClick={(e) => { e.stopPropagation(); openPreview(series); }}
                                                title="Flip through the file's pages to identify it before matching"
                                            >
                                                <BookOpen className="w-4 h-4 mr-1.5" /> Preview Pages
                                            </Button>
                                        </div>
                                    </div>
                                </div>

                                <ArrowRight className="hidden md:block w-6 h-6 text-muted-foreground/30 shrink-0" />

                                {/* SUGGESTION */}
                                <div className="flex-1 min-w-[250px] w-full md:w-auto bg-muted/50 p-3 rounded-xl border border-border">
                                    <div className="text-xs font-bold text-primary uppercase tracking-wider mb-2">{providerLabel} Suggestion</div>
                                    
                                    {!suggestion && isScanning && (
                                        <div className="flex items-center gap-3 text-muted-foreground animate-pulse py-2">
                                            <Loader2 className="w-5 h-5 animate-spin" /> Searching...
                                        </div>
                                    )}
                                    {!suggestion && !isScanning && (
                                        <div className="text-sm text-muted-foreground italic py-2">Click 'Start Auto-Scan' above to search.</div>
                                    )}
                                    {suggestion === 'NOT_FOUND' && (
                                        <div className="text-sm text-orange-500 font-medium py-2">No confident match found.</div>
                                    )}
                                    {suggestion === 'ERROR' && (
                                        <div className="text-sm text-red-500 font-medium py-2">Search failed. Rate limit hit?</div>
                                    )}
                                    {suggestion && suggestion !== 'NOT_FOUND' && suggestion !== 'ERROR' && (
                                        <div className="flex gap-3 items-center">
                                            <div className="w-12 h-16 shrink-0 rounded bg-muted border border-border overflow-hidden">
                                                {suggestion.image ? <img src={suggestion.image} className="w-full h-full object-cover" alt="Suggestion" /> : <ImageIcon className="w-4 h-4 m-auto mt-6 text-muted-foreground/50" />}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <h4 className="font-bold text-foreground break-words whitespace-normal text-sm leading-tight">{suggestion.name}</h4>
                                                <p className="text-xs text-muted-foreground break-words whitespace-normal mt-1">{suggestion.publisher || 'Unknown'} • {suggestion.year || '????'}</p>
                                                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                                                    <p className="text-[10px] text-muted-foreground/80">{suggestion.count} Issues</p>
                                                    <p className="text-[10px] font-mono font-bold text-muted-foreground/80 bg-muted px-1.5 py-0.5 rounded border border-border" title={`${providerLabel} ${providerLabel === 'Metron' ? 'Series' : 'Volume'} ID`}>
                                                        ID: {suggestion.id}
                                                    </p>
                                                    <a
                                                        href={(suggestion.metadataSource || searchProvider) === 'METRON' ? `https://metron.cloud/series/${suggestion.id}/` : `https://comicvine.gamespot.com/volume/4050-${suggestion.id}/`} 
                                                        target="_blank" 
                                                        rel="noopener noreferrer" 
                                                        className="text-[10px] font-bold text-primary hover:underline flex items-center gap-1"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <ExternalLink className="w-3 h-3" /> View Details
                                                    </a>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Custom metadata preview — shows where this match will actually land. */}
                                    {metadataOverrides[series.id] && (
                                        <div className="mt-2 pt-2 border-t border-border/60 flex items-start gap-1.5 text-[11px] text-primary" title="Folder this match will be organized into">
                                            <FolderTree className="w-3.5 h-3.5 mt-px shrink-0" />
                                            <span className="font-mono break-all leading-snug">
                                                {buildFolderPreview(folderPattern, {
                                                    name: metadataOverrides[series.id].name || suggestion?.name,
                                                    year: metadataOverrides[series.id].year || suggestion?.year,
                                                    publisher: metadataOverrides[series.id].publisher || suggestion?.publisher,
                                                    universe: metadataOverrides[series.id].universe,
                                                    seriesGroup: metadataOverrides[series.id].seriesGroup,
                                                }) || 'Custom metadata set'}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                {/* ACTIONS */}
                                <div className="flex md:flex-col gap-2 shrink-0 w-full md:w-auto justify-end">
                                    <Button 
                                        size="sm" 
                                        className="flex-1 md:flex-none bg-green-600 hover:bg-green-700 text-white font-bold disabled:opacity-50 border-0"
                                        disabled={!suggestion || suggestion === 'NOT_FOUND' || suggestion === 'ERROR' || isSelectionMode}
                                        onClick={(e) => { e.stopPropagation(); handleAcceptMatch(series, suggestion); }}
                                    >
                                        <Check className="w-5 h-5 md:mr-2" /> <span className="hidden md:inline">Accept</span>
                                    </Button>
                                    <Button 
                                        size="sm" 
                                        variant="outline" 
                                        className="flex-1 md:flex-none font-bold border-primary/30 text-primary hover:bg-primary/10"
                                        disabled={isSelectionMode}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setManualMatchTarget(series);
                                            setIsBulkManualMatch(false);
                                            setManualMatchOpen(true);
                                            setManualMatchResult(null);
                                            setManualMatchId("");
                                            setManualSearchQuery("");
                                            setManualSearchResults([]);
                                            setManualSearchPage(1);
                                            setHasMoreManualSearch(false);
                                            setIdMatchOpen(false);
                                            setExactIssueId(issueOverrides[series.id]?.issueId || "");
                                            setExactIssueNumber(issueOverrides[series.id]?.issueNumber || "");
                                            // #199 round 4: kick off the local-evidence read — if the
                                            // files carry a provider id, the id-assist effect takes it
                                            // from here and resolves the series without a search.
                                            fetchPrefill(series);
                                        }}
                                    >
                                        <Search className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Search Match</span>
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className={`flex-1 md:flex-none font-bold border-primary/30 text-primary hover:bg-primary/10 ${metadataOverrides[series.id] ? 'bg-primary/10' : ''}`}
                                        disabled={!suggestion || suggestion === 'NOT_FOUND' || suggestion === 'ERROR' || isSelectionMode}
                                        onClick={(e) => { e.stopPropagation(); openMetaEditor(series, suggestion); }}
                                        title="Fill in Series Group, Universe and other folder-naming details"
                                    >
                                        <Pencil className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">{metadataOverrides[series.id] ? 'Edit Details' : 'Edit Metadata'}</span>
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={isSelectionMode || pageManagerLoading}
                                        className="flex-1 md:flex-none font-bold border-primary/30 text-primary hover:bg-primary/10"
                                        onClick={(e) => { e.stopPropagation(); openPageManager([series]); }}
                                        title="Review and remove junk pages (scan credits) from this item's file(s)"
                                    >
                                        <Layers className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Pages</span>
                                    </Button>
                                    <Button size="sm" variant="outline" disabled={isSelectionMode} className="shrink-0 md:w-full border-border hover:bg-muted text-muted-foreground" onClick={(e) => { e.stopPropagation(); handleDismiss(series.id); }} title="Hide from Matcher">
                                        <X className="w-5 h-5 md:mr-2" /> <span className="hidden md:inline">Dismiss</span>
                                    </Button>
                                </div>

                            </Card>
                        )
                    })}
                </div>
            )}

            {/* --- NEW: BULK SELECTION ACTION BAR --- */}
            {isSelectionMode && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-background text-foreground px-4 sm:px-6 py-3 rounded-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.5)] flex items-center gap-3 sm:gap-4 z-50 animate-in slide-in-from-bottom-8 border border-border w-[95%] sm:w-auto overflow-x-auto">
                    <Button variant="ghost" size="sm" className="h-10 sm:h-8 shrink-0 hover:bg-muted text-muted-foreground font-medium" onClick={() => {
                        if (selectedItems.size === unmatched.length && unmatched.length > 0) setSelectedItems(new Set());
                        else setSelectedItems(new Set(unmatched.map(s => s.id)));
                    }}>
                        {selectedItems.size === unmatched.length && unmatched.length > 0 ? "Deselect All" : "Select All"}
                    </Button>
                    <div className="h-5 w-px bg-border shrink-0" />
                    <span className="font-black whitespace-nowrap min-w-[60px] sm:min-w-[100px] text-center text-sm sm:text-base shrink-0">{selectedItems.size} Selected</span>
                    
                    <div className="flex gap-2 shrink-0">
                        <Button 
                            size="sm" 
                            variant="outline" 
                            className="h-10 sm:h-8 shadow-sm font-bold transition-all border-primary/50 text-primary hover:bg-muted" 
                            disabled={selectedItems.size === 0 || isBulkProcessing} 
                            onClick={() => {
                                setIsBulkManualMatch(true);
                                setManualMatchTarget(null);
                                setManualMatchOpen(true);
                                setManualMatchResult(null);
                                setManualMatchId("");
                                setManualSearchQuery("");
                                setManualSearchResults([]);
                                setManualSearchPage(1);
                                setHasMoreManualSearch(false);
                                setIdMatchOpen(false);
                                setBulkSeriesGroup("");
                                setBulkUniverse("");
                            }}
                        >
                            <Search className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Search Match</span>
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-10 sm:h-8 shadow-sm font-bold transition-all border-primary/50 text-primary hover:bg-muted"
                            disabled={selectedItems.size === 0 || isBulkProcessing || pageManagerLoading}
                            onClick={() => openPageManager(unmatched.filter(s => selectedItems.has(s.id)))}
                            title="Review and remove junk pages (scan credits) from the selected items' files"
                        >
                            {pageManagerLoading ? <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" /> : <Layers className="w-4 h-4 sm:mr-2" />}
                            <span className="hidden sm:inline">Manage Pages</span>
                        </Button>
                        <Button
                            size="sm"
                            className="h-10 sm:h-8 shadow-sm font-bold transition-all bg-green-600 hover:bg-green-700 text-white"
                            disabled={selectedItems.size === 0 || isBulkProcessing || Array.from(selectedItems).every(id => !suggestions[id] || suggestions[id] === 'NOT_FOUND' || suggestions[id] === 'ERROR')}
                            onClick={handleBulkAccept}
                        >
                            {isBulkProcessing ? <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" /> : <Check className="w-4 h-4 sm:mr-2" />}
                            <span className="hidden sm:inline">Accept Selected</span>
                        </Button>
                    </div>
                </div>
            )}

            {/* PAGE MANAGER (issue #189): exploded page view for matcher items */}
            <PageManagerModal
                open={pageManagerOpen}
                onOpenChange={setPageManagerOpen}
                queue={pageManagerQueue}
                onApplied={() => { /* page counts changed; the matcher list itself is unaffected */ }}
            />
            <ConfirmationDialog
                isOpen={!!pendingPageQueue}
                onClose={() => setPendingPageQueue(null)}
                onConfirm={() => {
                    if (pendingPageQueue) {
                        setPageManagerQueue(pendingPageQueue);
                        setPageManagerOpen(true);
                    }
                    setPendingPageQueue(null);
                }}
                title="Review pages for a large selection?"
                description={`This opens a page review for ${pendingPageQueue?.length ?? 0} issues, one at a time. You can skip any issue and close at any point — deletions only happen per issue when you confirm them.`}
                confirmText="Start Review"
            />

            {/* SEARCH MATCH DIALOG — search-by-name first (#199 round 2), exact-ID lookup as the
                advanced fallback below it. Both paths resolve through resolveVolumeSelection. */}
            <Dialog open={manualMatchOpen} onOpenChange={setManualMatchOpen}>
                <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col bg-background border-border rounded-xl w-[95%]">
                    <DialogHeader className="shrink-0">
                        <DialogTitle>Search Match</DialogTitle>
                        <DialogDescription>
                            {isBulkManualMatch
                                ? `Search for the series to apply to the ${selectedItems.size} selected items.`
                                : `Search for the correct series for ${manualMatchTarget?.name}.`}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="py-2 pr-3 space-y-4 flex-1 min-h-0 overflow-y-auto">
                        {metronConfigured && (
                            <div className="space-y-2">
                                <Label>Metadata Source</Label>
                                <Select value={searchProvider} onValueChange={setSearchProvider}>
                                    <SelectTrigger className="bg-background border-border">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="COMICVINE">ComicVine</SelectItem>
                                        <SelectItem value="METRON">Metron.Cloud</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
                        
                        <div className="space-y-2">
                            <Label>Series Name</Label>
                            <div className="flex gap-2 items-start">
                                <Input
                                    value={manualSearchQuery}
                                    onChange={(e) => setManualSearchQuery(e.target.value)}
                                    placeholder="e.g. The Amazing Spider-Man"
                                    className="bg-background border-border flex-1"
                                    onKeyDown={(e) => e.key === 'Enter' && manualSearchQuery.trim() && handleManualSearch()}
                                />
                                <Button onClick={() => handleManualSearch()} disabled={isManualSearching || manualSearchQuery.trim().length < 2} className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 font-bold">
                                    {isManualSearching ? <Loader2 className="w-4 h-4 animate-spin md:mr-2" /> : <Search className="w-4 h-4 md:mr-2" />}
                                    <span className="hidden md:inline">Search</span>
                                </Button>
                            </div>

                            {manualSearchResults.length > 0 && (
                                <div className="mt-2 space-y-1.5 max-h-56 overflow-y-auto pr-1 border border-border rounded-lg p-2 bg-muted/20">
                                    {manualSearchResults.map((item) => (
                                        <button
                                            key={`${item.metadataSource || searchProvider}-${item.id}`}
                                            type="button"
                                            disabled={isManualMatching}
                                            onClick={() => handleSelectSearchResult(item)}
                                            className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors disabled:opacity-50 ${manualMatchResult?.id === item.id ? 'bg-primary/10 border border-primary/40' : 'border border-transparent hover:bg-muted'}`}
                                        >
                                            <div className="w-8 h-11 shrink-0 rounded bg-muted border border-border overflow-hidden">
                                                {item.image ? <img src={item.image} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-3 h-3 m-auto mt-3.5 text-muted-foreground/50" />}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs font-bold text-foreground truncate">{item.name}</p>
                                                <p className="text-[10px] text-muted-foreground truncate">{item.publisher || 'Unknown'} • {item.year || '????'} • {item.count || 0} issues</p>
                                            </div>
                                            {isManualMatching && manualMatchResult?.id === item.id && <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />}
                                            {!isManualMatching && manualMatchResult?.id === item.id && <Check className="w-4 h-4 text-primary shrink-0" />}
                                        </button>
                                    ))}
                                    {hasMoreManualSearch && (
                                        <div className="pt-1 flex justify-center">
                                            <Button variant="secondary" size="sm" onClick={() => handleManualSearch(true)} disabled={isManualSearchingMore} className="font-bold">
                                                {isManualSearchingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                                                Load more
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* ADVANCED: the classic exact-provider-ID lookup, kept for admins who already
                            have the id (or a series the name search can't surface). */}
                        <div className="space-y-2">
                            <button
                                type="button"
                                onClick={() => setIdMatchOpen(o => !o)}
                                className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                            >
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${idMatchOpen ? 'rotate-90' : ''}`} />
                                Match by exact provider ID
                            </button>
                            {idMatchOpen && (
                                <div className="space-y-2 pl-4 border-l-2 border-border ml-1.5">
                                    <Label className="text-xs">{searchProvider === 'METRON' ? 'Metron Series ID (or Slug)' : 'ComicVine Volume ID'}</Label>
                                    <div className="flex gap-2 items-start">
                                        <Input
                                            value={manualMatchId}
                                            onChange={(e) => setManualMatchId(e.target.value)}
                                            placeholder="e.g. 4050-12345 or 12746"
                                            className="bg-background border-border flex-1"
                                            onKeyDown={(e) => e.key === 'Enter' && manualMatchId && handleManualLookup()}
                                        />
                                        <Button onClick={handleManualLookup} disabled={isManualMatching || !manualMatchId} variant="outline" className="shrink-0 border-primary/30 text-primary hover:bg-primary/10 font-bold">
                                            {isManualMatching ? <Loader2 className="w-4 h-4 animate-spin md:mr-2" /> : <Search className="w-4 h-4 md:mr-2" />}
                                            <span className="hidden md:inline">Look Up</span>
                                        </Button>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground mt-1.5">
                                        Tip: find IDs on <a href="https://comicvine.gamespot.com/volumes/" target="_blank" rel="noreferrer" className="text-primary underline">ComicVine</a> or <a href="https://metron.cloud/series/" target="_blank" rel="noreferrer" className="text-primary underline">Metron</a>.
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* --- NEW: SERIES PREVIEW --- */}
                        {manualMatchResult && (
                            <div className="mt-4 p-3 bg-muted/40 rounded-xl border border-border flex gap-4 items-start animate-in fade-in slide-in-from-top-2">
                                <div className="w-[72px] h-[108px] shrink-0 rounded bg-background border border-border overflow-hidden shadow-sm">
                                    {manualMatchResult.image ? <img src={manualMatchResult.image} className="w-full h-full object-cover" alt="Cover" /> : <ImageIcon className="w-6 h-6 m-auto mt-10 text-muted-foreground/50" />}
                                </div>
                                <div className="min-w-0 flex-1 flex flex-col">
                                    <h4 className="font-bold text-foreground break-words whitespace-normal text-sm leading-tight">{manualMatchResult.name}</h4>
                                    
                                    <div className="flex items-center gap-2 mt-1.5 mb-2 flex-wrap">
                                        <p className="text-[11px] font-medium text-muted-foreground shrink-0">{manualMatchResult.publisher || 'Unknown'} • {manualMatchResult.year || '????'}</p>
                                        <div className="inline-flex px-1.5 py-0.5 rounded-md bg-primary/10 text-primary text-[9px] font-bold border border-primary/20 uppercase tracking-wider shrink-0">
                                            {manualMatchResult.count} Issues
                                        </div>
                                        
                                        {/* --- NEW: Dynamic External Link --- */}
                                        <a 
                                            href={manualMatchResult.metadataSource === 'METRON' ? `https://metron.cloud/series/${manualMatchResult.id}/` : `https://comicvine.gamespot.com/volume/4050-${manualMatchResult.id}/`} 
                                            target="_blank" 
                                            rel="noopener noreferrer" 
                                            className="text-[10px] font-bold text-primary hover:underline flex items-center gap-1 ml-auto shrink-0"
                                        >
                                            <ExternalLink className="w-3 h-3" /> 
                                            View on {manualMatchResult.metadataSource === 'METRON' ? 'Metron' : 'ComicVine'}
                                        </a>
                                    </div>

                                    {manualMatchResult.description && (
                                        <p className="text-[11px] text-muted-foreground/80 leading-snug line-clamp-4" title={manualMatchResult.description}>
                                            {manualMatchResult.description}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Single-item: jump into the metadata editor (applies the match, then opens the editor). */}
                        {manualMatchResult && !isBulkManualMatch && manualMatchTarget && (
                            <Button
                                variant="outline"
                                className={`w-full border-primary/30 text-primary hover:bg-primary/10 font-bold ${metadataOverrides[manualMatchTarget.id] ? 'bg-primary/10' : ''}`}
                                onClick={() => { handleApplyManualMatch(); openMetaEditor(manualMatchTarget, manualMatchResult); }}
                            >
                                <Pencil className="w-4 h-4 mr-2" />
                                {metadataOverrides[manualMatchTarget.id] ? 'Edit Naming Details' : 'Add Series Group / Universe…'}
                            </Button>
                        )}

                        {/* Bulk: a shared Series Group / Universe applied to every selected item on Apply. */}
                        {manualMatchResult && isBulkManualMatch && (
                            <div className="space-y-3 mt-2 pt-4 border-t border-border">
                                <h4 className="font-bold text-sm text-primary flex items-center gap-2">
                                    <FolderTree className="w-4 h-4" /> Shared Naming (Optional)
                                </h4>
                                <p className="text-xs text-muted-foreground leading-tight">
                                    Group all {selectedItems.size} selected series under one umbrella folder. Applied to each item on Apply.
                                </p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <Label className="text-[11px] text-muted-foreground uppercase">Series Group</Label>
                                        <Input placeholder="e.g. X-Men" value={bulkSeriesGroup} onChange={e => setBulkSeriesGroup(e.target.value)} className="bg-background border-border h-9" />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[11px] text-muted-foreground uppercase">Universe / Imprint</Label>
                                        <Input placeholder="e.g. Earth-616" value={bulkUniverse} onChange={e => setBulkUniverse(e.target.value)} className="bg-background border-border h-9" />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* --- OPTIONAL ISSUE MAPPING (Only visible if preview loaded) --- */}
                        {manualMatchResult && ((manualMatchTarget?.isRawFile && !isBulkManualMatch) || isBulkManualMatch) && (
                            <div className="space-y-3 mt-2 pt-4 border-t border-border animate-in fade-in">
                                <h4 className="font-bold text-sm text-primary flex items-center gap-2">
                                    <FileText className="w-4 h-4" /> Issue Mapping (Auto-Filled)
                                </h4>
                                <p className="text-xs text-muted-foreground leading-tight">
                                    Omnibus has extracted the issue numbers and cross-referenced them with the API to auto-fill exact Issue IDs. You can manually correct these below before applying — got the right series but the wrong issue? Fix the Issue Number, then hit &quot;Refresh from number&quot; to re-resolve the exact ID.
                                </p>
                                
                                {/* Single Match View */}
                                {!isBulkManualMatch && manualMatchTarget && (
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="space-y-1">
                                                <Label className="text-[11px] text-muted-foreground uppercase">Issue Number</Label>
                                                <Input
                                                    placeholder="e.g. 1"
                                                    value={issueOverrides[manualMatchTarget.id]?.issueNumber ?? exactIssueNumber}
                                                    onChange={e => {
                                                        setExactIssueNumber(e.target.value);
                                                        setIssueOverrides(prev => ({ ...prev, [manualMatchTarget.id]: { ...prev[manualMatchTarget.id], issueNumber: e.target.value } }));
                                                    }}
                                                    className="bg-background border-border h-9"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <div className="flex items-center justify-between">
                                                    <Label className="text-[11px] text-muted-foreground uppercase">Exact Issue ID</Label>
                                                    <button
                                                        type="button"
                                                        onClick={handleReresolveIssueId}
                                                        disabled={isReresolvingIssueId}
                                                        className="text-[10px] font-bold text-primary hover:underline flex items-center gap-1 disabled:opacity-50"
                                                        title="Wrong issue matched? Fix the Issue Number, then re-resolve the exact ID from it."
                                                    >
                                                        {isReresolvingIssueId ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                                        Refresh from number
                                                    </button>
                                                </div>
                                                <Input
                                                    placeholder="Optional"
                                                    value={issueOverrides[manualMatchTarget.id]?.issueId ?? exactIssueId}
                                                    onChange={e => {
                                                        setExactIssueId(e.target.value);
                                                        setIssueOverrides(prev => ({ ...prev, [manualMatchTarget.id]: { ...prev[manualMatchTarget.id], issueId: e.target.value } }));
                                                    }}
                                                    className="bg-background border-border h-9"
                                                />
                                            </div>
                                        </div>
                                        {/* #199 round 3: the bound ID gets a face — title, cover, credits —
                                            so the auto-map (or a refresh) can be verified before Accept. */}
                                        <SmartMatchBoundIssue
                                            issueId={issueOverrides[manualMatchTarget.id]?.issueId ?? exactIssueId}
                                            provider={manualMatchResult?.metadataSource || searchProvider}
                                        />
                                        <div className="space-y-1">
                                            <Label className="text-[11px] text-muted-foreground uppercase">Issue Cover (optional)</Label>
                                            <div className="flex items-center gap-3">
                                                <div className="w-12 h-16 shrink-0 rounded bg-muted border border-border overflow-hidden flex items-center justify-center">
                                                    {issueOverrides[manualMatchTarget.id]?.coverImageBase64
                                                        ? <img src={issueOverrides[manualMatchTarget.id]?.coverImageBase64} className="w-full h-full object-cover" alt="Issue cover" />
                                                        : <ImageIcon className="w-4 h-4 text-muted-foreground/40" />}
                                                </div>
                                                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/30 text-primary text-xs font-bold cursor-pointer hover:bg-primary/10">
                                                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => { handleIssueCoverPick(manualMatchTarget.id, e.target.files?.[0]); e.currentTarget.value = ''; }} />
                                                    <Upload className="w-3.5 h-3.5" /> {issueOverrides[manualMatchTarget.id]?.coverImageBase64 ? 'Replace' : 'Choose'}
                                                </label>
                                                {issueOverrides[manualMatchTarget.id]?.coverImageBase64 && (
                                                    <button type="button" onClick={() => setIssueOverrides(prev => ({ ...prev, [manualMatchTarget.id]: { ...prev[manualMatchTarget.id], coverImageBase64: undefined } }))} className="text-[11px] text-muted-foreground hover:text-foreground underline">
                                                        Clear
                                                    </button>
                                                )}
                                            </div>
                                            {issueOverrides[manualMatchTarget.id]?.coverImageBase64 && (
                                                <label className="flex items-center gap-2 pt-1 cursor-pointer" title="Issue #189 follow-up: insert-only — an old cover page is removed via Manage Pages; CBR/CB7 repack as CBZ.">
                                                    <Checkbox checked={embedIssueCovers} onCheckedChange={(c) => updateEmbedIssueCovers(!!c)} />
                                                    <span className="text-xs text-muted-foreground">Also embed as the archive&apos;s first page on Accept</span>
                                                </label>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Bulk Match View */}
                                {isBulkManualMatch && Array.from(selectedItems).map(id => {
                                    const item = unmatched.find(s => s.id === id);
                                    if (!item?.isRawFile) return null;
                                    
                                    return (
                                        <div key={id} className="grid grid-cols-1 sm:grid-cols-12 gap-2 p-2.5 border border-border rounded-lg bg-muted/20 items-center">
                                            <div className="sm:col-span-5 truncate text-xs font-medium text-foreground" title={item.name}>
                                                {item.name}
                                            </div>
                                            <div className="sm:col-span-2">
                                                <Input
                                                    placeholder="Issue #"
                                                    value={issueOverrides[id]?.issueNumber || ""}
                                                    onChange={e => setIssueOverrides(prev => ({ ...prev, [id]: { ...prev[id], issueNumber: e.target.value, issueId: prev[id]?.issueId || "" } }))}
                                                    className="h-8 text-xs bg-background border-border"
                                                />
                                            </div>
                                            <div className="sm:col-span-3">
                                                <Input
                                                    placeholder="Issue ID"
                                                    value={issueOverrides[id]?.issueId || ""}
                                                    onChange={e => setIssueOverrides(prev => ({ ...prev, [id]: { ...prev[id], issueId: e.target.value, issueNumber: prev[id]?.issueNumber || "" } }))}
                                                    className="h-8 text-xs bg-background border-border"
                                                />
                                            </div>
                                            <div className="sm:col-span-2 flex items-center gap-1.5">
                                                <label className="relative w-8 h-8 shrink-0 rounded border border-border overflow-hidden cursor-pointer flex items-center justify-center bg-muted hover:border-primary/50" title={(issueOverrides[id]?.coverImageBase64 ? "Replace issue cover" : "Set issue cover") + (embedIssueCovers ? " (embeds into the archive on Accept)" : "")}>
                                                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => { handleIssueCoverPick(id, e.target.files?.[0]); e.currentTarget.value = ''; }} />
                                                    {issueOverrides[id]?.coverImageBase64
                                                        ? <img src={issueOverrides[id]?.coverImageBase64} className="w-full h-full object-cover" alt="" />
                                                        : <Upload className="w-3.5 h-3.5 text-muted-foreground" />}
                                                </label>
                                                {issueOverrides[id]?.coverImageBase64 && (
                                                    <button type="button" onClick={() => setIssueOverrides(prev => ({ ...prev, [id]: { ...prev[id], coverImageBase64: undefined } }))} className="text-muted-foreground hover:text-foreground" title="Clear">
                                                        <X className="w-3.5 h-3.5" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    
                    <DialogFooter className="gap-2 mt-2 shrink-0">
                        <Button variant="outline" onClick={() => { setManualMatchOpen(false); setManualMatchResult(null); }} className="border-border hover:bg-muted text-foreground">Cancel</Button>
                        <Button onClick={handleApplyManualMatch} disabled={!manualMatchResult} className="bg-green-600 text-white hover:bg-green-700 font-bold">
                            <Check className="w-4 h-4 mr-2" /> Apply Match
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmationDialog
                isOpen={mergeWarnOpen}
                onClose={() => setMergeWarnOpen(false)}
                onConfirm={() => { setMergeWarnOpen(false); doApplyManualMatch(); }}
                title="Merge these folders into one series?"
                description={`You're assigning the same series to ${mergeWarnCount} folders, which combines them into a single series (their issues are moved together). That's rarely what you want for separate series — continue only if these folders really are the same series.`}
                confirmText="Merge anyway"
                cancelText="Cancel"
                variant="destructive"
            />

            {/* PER-ITEM METADATA EDITOR — fill Series Group / Universe / identity before accepting. */}
            <SmartMatchMetadataDialog
                open={metaEditorOpen}
                onOpenChange={setMetaEditorOpen}
                targetLabel={metaEditorTarget?.name}
                seed={metaEditorSeed}
                folderPattern={folderPattern}
                initialOverride={metaEditorTarget ? metadataOverrides[metaEditorTarget.id] : undefined}
                defaultWriteToFile={writeToFileDefault}
                showIssueCover={!!metaEditorTarget?.isRawFile}
                archiveFilePath={metaEditorTarget?.isRawFile ? metaEditorTarget.folderPath : undefined}
                initialIssueCover={metaEditorTarget ? issueOverrides[metaEditorTarget.id]?.coverImageBase64 : undefined}
                initialIssueCoverFromArchive={metaEditorTarget ? issueOverrides[metaEditorTarget.id]?.coverFromArchive : undefined}
                onSave={handleMetaSave}
                // #199 round 2 (loose files): the wrong issue can be bound within a correct series
                // match — the dialog's General tab lets the admin fix the number and re-resolve the
                // exact issue ID right there. Both stores stay in sync with the Issue Mapping picker.
                issueNumber={metaEditorTarget?.isRawFile ? (issueOverrides[metaEditorTarget.id]?.issueNumber ?? extractIssueNumber(metaEditorTarget.name || '')) : undefined}
                // #199 round 3: the bound-issue confirmation card inside the dialog reads the same
                // per-item binding the Issue Mapping picker maintains, so all three stay in step.
                issueId={metaEditorTarget?.isRawFile ? (issueOverrides[metaEditorTarget.id]?.issueId || undefined) : undefined}
                onIssueNumberChange={(v) => {
                    if (!metaEditorTarget) return;
                    setExactIssueNumber(v);
                    setIssueOverrides(prev => ({ ...prev, [metaEditorTarget.id]: { ...prev[metaEditorTarget.id], issueNumber: v } }));
                }}
                onIssueIdChange={(id) => {
                    if (!metaEditorTarget) return;
                    setExactIssueId(id);
                    setIssueOverrides(prev => ({ ...prev, [metaEditorTarget.id]: { ...prev[metaEditorTarget.id], issueId: id } }));
                }}
                seriesMetadataId={metaEditorSeed?.metadataId}
                metadataSource={metaEditorSeed?.metadataSource}
                // #199 round 4: the library's own metadata seeds the fields (file-first), and the
                // matched volume's credits back the explicit "fill empty fields" action.
                prefill={metaEditorTarget ? (prefills[metaEditorTarget.id] || undefined) : undefined}
                providerFields={metaEditorSeed?.credits ?? (metaEditorTarget ? suggestions[metaEditorTarget.id]?.credits : undefined)}
            />

            {/* --- PAGE PREVIEW DIALOG: flip through an unmatched file before matching it --- */}
            <Dialog open={previewOpen} onOpenChange={(open) => { if (!open) { setPreviewOpen(false); setPreviewTarget(null); setPreviewFile(null); } }}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle className="pr-8 break-words">{previewTarget?.name || 'Preview'}</DialogTitle>
                        <DialogDescription className="break-all text-xs">{previewFile || previewTarget?.folderPath}</DialogDescription>
                    </DialogHeader>

                    {previewLoading && (
                        <div className="flex items-center justify-center py-20 text-muted-foreground">
                            <Loader2 className="w-8 h-8 animate-spin" />
                        </div>
                    )}

                    {!previewLoading && previewError && (
                        <div className="text-center py-16 text-muted-foreground text-sm">{previewError}</div>
                    )}

                    {!previewLoading && !previewError && previewIsRar && previewFile && (
                        <div className="space-y-3">
                            <div className="bg-black/40 rounded-lg overflow-hidden flex items-center justify-center min-h-[300px]">
                                {/* RAR-family archives can't be page-listed — the archive-cover route extracts
                                    the first page natively (unrar), so at least the cover is identifiable. */}
                                <img
                                    src={`/api/library/archive-cover?path=${encodeURIComponent(previewFile)}`}
                                    className="max-h-[65vh] w-auto object-contain"
                                    alt="First page"
                                />
                            </div>
                            <p className="text-center text-xs text-muted-foreground">
                                RAR archive — only the first page can be previewed. Convert to CBZ for full paging.
                            </p>
                        </div>
                    )}

                    {!previewLoading && !previewError && !previewIsRar && previewFile && previewCount > 0 && (
                        <div className="space-y-3">
                            <div className="bg-black/40 rounded-lg overflow-hidden flex items-center justify-center min-h-[300px]">
                                <img
                                    key={previewIndex}
                                    src={`/api/library/archive-preview?path=${encodeURIComponent(previewFile)}&page=${previewIndex}`}
                                    className="max-h-[65vh] w-auto object-contain"
                                    alt={`Page ${previewIndex + 1}`}
                                />
                            </div>
                            <div className="flex items-center justify-center gap-4">
                                <Button variant="outline" size="sm" className="font-bold" disabled={previewIndex <= 0} onClick={() => setPreviewIndex(i => Math.max(0, i - 1))}>
                                    <ChevronLeft className="w-4 h-4" />
                                </Button>
                                <span className="text-sm font-bold text-muted-foreground tabular-nums">
                                    Page {previewIndex + 1} / {previewCount}
                                </span>
                                <Button variant="outline" size="sm" className="font-bold" disabled={previewIndex >= previewCount - 1} onClick={() => setPreviewIndex(i => Math.min(previewCount - 1, i + 1))}>
                                    <ChevronRight className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

        </div>
    )
}