// src/app/admin/smart-match/page.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Sparkles, Check, X, FolderSearch, ArrowRight, Image as ImageIcon, ArrowLeft, FileText, Search, Square, CheckSquare, ExternalLink, Pencil, FolderTree, Upload } from "lucide-react"
import Link from "next/link"
import { Logger } from "@/lib/logger"
import { getErrorMessage } from "@/lib/utils/error"
import { extractIssueNumber } from "@/lib/utils/issue-parser"
import SmartMatchMetadataDialog, { type SmartMatchOverride, buildFolderPreview } from "@/components/smart-match-metadata-dialog"
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

export default function SmartMatchPage() {
    const [unmatched, setUnmatched] = useState<any[]>([]);
    const [suggestions, setSuggestions] = useState<Record<string, any>>({});
    const [isScanning, setIsScanning] = useState(false);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const [manualMatchOpen, setManualMatchOpen] = useState(false);
    const [manualMatchId, setManualMatchId] = useState("");
    const [manualMatchTarget, setManualMatchTarget] = useState<any>(null);
    const [isManualMatching, setIsManualMatching] = useState(false);

    const [exactIssueId, setExactIssueId] = useState("");
    const [exactIssueNumber, setExactIssueNumber] = useState("");
    const [issueOverrides, setIssueOverrides] = useState<Record<string, { issueId: string, issueNumber: string, coverImageBase64?: string }>>({});
    const [manualMatchResult, setManualMatchResult] = useState<any>(null);
    
    // --- NEW: Multi-Select & Bulk Processing State ---
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [isBulkProcessing, setIsBulkProcessing] = useState(false);
    const [isBulkManualMatch, setIsBulkManualMatch] = useState(false);
    // Guard: warn before a bulk Custom-ID applies the same series to multiple FOLDERS (which merges them).
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

    const { toast } = useToast();

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

    const handleAcceptMatch = async (series: any, suggestion: any) => {
        setProcessingId(series.id);
        try {
            Logger.log(`[Smart Match Debug] Accepting match for "${series.name}". Linking to ${suggestion.metadataSource || 'COMICVINE'} ID: ${suggestion.id}`, 'debug');
            
            const issueOv = issueOverrides[series.id] || {};
            const meta = metadataOverrides[series.id];

            const res = await fetch('/api/library/match-series', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
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
                    } : {}),
                    exactIssueId: issueOv.issueId || undefined,
                    exactIssueNumber: issueOv.issueNumber || undefined,
                    issueCoverImageBase64: issueOv.coverImageBase64 || undefined
                })
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

    const handleManualLookup = async () => {
        setIsManualMatching(true);
        setManualMatchResult(null); // Reset previous searches
        try {
            const cleanId = manualMatchId.replace('4050-', '').replace(/[^0-9a-zA-Z-]/g, '');
            if (!cleanId) throw new Error("Invalid ID format");

            Logger.log(`[Smart Match Debug] Manual lookup initiated for ID: ${cleanId} via ${searchProvider}`, 'debug');
            
            const res = await fetch(`/api/issue-details?id=${cleanId}&type=volume&provider=${searchProvider}`);
            const data = await res.json();

            if (res.ok && data && !data.error) {
                // FIX: Accurately parse the issue count from either API
                const issueCount = data.count || data.count_of_issues || data.issue_count || data.issues?.length || "?";

                const suggestionData = {
                    id: data.id || data.volumeId,
                    name: data.name,
                    year: data.year,
                    publisher: data.publisher,
                    image: data.image,
                    count: issueCount,
                    description: data.description,
                    metadataSource: searchProvider,
                    rawIssues: data.issues || [] // Hold onto raw issues for cross-referencing IDs
                };

                // Show preview instead of closing modal
                setManualMatchResult(suggestionData);
                
                // AUTO-MAP: Extract issue numbers and match IDs
                const newOverrides = { ...issueOverrides };
                const itemsToMap = isBulkManualMatch ? Array.from(selectedItems) : (manualMatchTarget ? [manualMatchTarget.id] : []);

                itemsToMap.forEach(id => {
                    const item = unmatched.find(s => s.id === id);
                    if (item?.isRawFile) {
                        const extractedNum = extractIssueNumber(item.name);
                        let matchedIssueId = "";

                        // If the API provided the volume's issue list, try to find the exact ID match
                        if (suggestionData.rawIssues?.length > 0) {
                            const apiIssue = suggestionData.rawIssues.find((i: any) => {
                                const apiNum = i.issue_number?.toString() || i.number?.toString();
                                return apiNum?.replace(/^0+(?=\d)/, '') === extractedNum.replace(/^0+(?=\d)/, '');
                            });
                            if (apiIssue) matchedIssueId = apiIssue.id?.toString() || "";
                        }

                        newOverrides[id] = { issueNumber: extractedNum, issueId: matchedIssueId };
                        
                        // Update individual states for single-match mode
                        if (!isBulkManualMatch) {
                            setExactIssueNumber(extractedNum);
                            setExactIssueId(matchedIssueId);
                        }
                    }
                });

                setIssueOverrides(newOverrides);
                toast({ title: "Volume Found", description: "Review the metadata and issue mappings, then click Apply Match." });

            } else {
                throw new Error(data.error || "Volume not found");
            }
        } catch (e: any) {
            toast({ title: "Lookup Failed", description: e.message, variant: "destructive" });
        } finally {
            setIsManualMatching(false);
        }
    };

    // Applying ONE Custom ID to multiple FOLDERS assigns them all the same series, which merges them into
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
            toast({ title: "Custom ID Applied", description: (sg || uni) ? "Matches + metadata set for selected items. Click 'Accept Selected' to save." : "Matches set for selected items. Click 'Accept Selected' to confirm and save." });
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
    const openMetaEditor = (target: any, seedSource: any) => {
        setMetaEditorTarget(target);
        setMetaEditorSeed(seedSource ? {
            name: seedSource.name,
            year: seedSource.year,
            publisher: seedSource.publisher,
            description: seedSource.description,
            image: seedSource.image,
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
                </div>
            </div>

            {/* METADATA PROVIDER QUICKLINKS */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 pt-3 border-t border-border/40 text-xs text-muted-foreground">
                <span className="font-medium">Need to find an ID? Search providers:</span>
                <a 
                    href="https://comicvine.gamespot.com/volumes/" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="flex items-center gap-1 font-semibold text-primary hover:underline transition-colors"
                >
                    ComicVine Volumes <ExternalLink className="w-3 h-3 text-muted-foreground/70" />
                </a>
                <span className="text-border">|</span>
                <a 
                    href="https://metron.cloud/series/" 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="flex items-center gap-1 font-semibold text-primary hover:underline transition-colors"
                >
                    Metron Series <ExternalLink className="w-3 h-3 text-muted-foreground/70" />
                </a>
            </div>

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
                                            setExactIssueId(issueOverrides[series.id]?.issueId || "");
                                            setExactIssueNumber(issueOverrides[series.id]?.issueNumber || "");
                                        }}
                                    >
                                        <Search className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Custom ID</span>
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
                                setBulkSeriesGroup("");
                                setBulkUniverse("");
                            }}
                        >
                            <Search className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Set Custom ID</span>
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

            {/* MANUAL MATCH DIALOG */}
            <Dialog open={manualMatchOpen} onOpenChange={setManualMatchOpen}>
                <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col bg-background border-border rounded-xl w-[95%]">
                    <DialogHeader className="shrink-0">
                        <DialogTitle>Manual Match</DialogTitle>
                        <DialogDescription>
                            {isBulkManualMatch
                                ? `Enter the exact ID to apply to the ${selectedItems.size} selected items.`
                                : `Enter the exact ID for ${manualMatchTarget?.name}.`}
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
                            <Label>{searchProvider === 'METRON' ? 'Metron Series ID (or Slug)' : 'ComicVine Volume ID'}</Label>
                            <div className="flex gap-2 items-start">
                                <Input 
                                    value={manualMatchId} 
                                    onChange={(e) => setManualMatchId(e.target.value)} 
                                    placeholder="e.g. 4050-12345 or 12746"
                                    className="bg-background border-border flex-1"
                                    onKeyDown={(e) => e.key === 'Enter' && manualMatchId && handleManualLookup()}
                                />
                                <Button onClick={handleManualLookup} disabled={isManualMatching || !manualMatchId} className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 font-bold">
                                    {isManualMatching ? <Loader2 className="w-4 h-4 animate-spin md:mr-2" /> : <Search className="w-4 h-4 md:mr-2" />} 
                                    <span className="hidden md:inline">Look Up</span>
                                </Button>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-1.5">
                                Tip: Search on <a href="https://comicvine.gamespot.com/volumes/" target="_blank" rel="noreferrer" className="text-primary underline">ComicVine</a> or <a href="https://metron.cloud/series/" target="_blank" rel="noreferrer" className="text-primary underline">Metron</a> to find the correct volume/series ID.
                            </p>
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
                                    Omnibus has extracted the issue numbers and cross-referenced them with the API to auto-fill exact Issue IDs. You can manually correct these below before applying.
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
                                                <Label className="text-[11px] text-muted-foreground uppercase">Exact Issue ID</Label>
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
                                                <label className="relative w-8 h-8 shrink-0 rounded border border-border overflow-hidden cursor-pointer flex items-center justify-center bg-muted hover:border-primary/50" title={issueOverrides[id]?.coverImageBase64 ? "Replace issue cover" : "Set issue cover"}>
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
                onSave={handleMetaSave}
            />

        </div>
    )
}