// src/app/admin/smart-match/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Sparkles, Check, X, FolderSearch, ArrowRight, Image as ImageIcon, ArrowLeft, FileText, Search, Square, CheckSquare, ExternalLink } from "lucide-react"
import Link from "next/link"
import { Logger } from "@/lib/logger"
import { getErrorMessage } from "@/lib/utils/error"

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
    
    // --- NEW: Multi-Select & Bulk Processing State ---
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [isBulkProcessing, setIsBulkProcessing] = useState(false);
    const [isBulkManualMatch, setIsBulkManualMatch] = useState(false);

    const [searchProvider, setSearchProvider] = useState("COMICVINE");
    const [metronConfigured, setMetronConfigured] = useState(false);

    const { toast } = useToast();

    useEffect(() => {
        fetch('/api/admin/config')
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data?.settings) {
                    const mUser = data.settings.find((s: any) => s.key === 'metron_user')?.value;
                    const mPass = data.settings.find((s: any) => s.key === 'metron_pass')?.value;
                    const primary = data.settings.find((s: any) => s.key === 'primary_metadata_source')?.value;
                    if (mUser && mPass) setMetronConfigured(true);
                    if (primary) setSearchProvider(primary);
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
            
            const res = await fetch('/api/library/match-series', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    oldFolderPath: series.folderPath,
                    cvId: suggestion.id,
                    metadataId: suggestion.id,
                    metadataSource: suggestion.metadataSource || 'COMICVINE',
                    name: suggestion.name,
                    year: suggestion.year,
                    publisher: suggestion.publisher
                })
            });

            if (res.ok) {
                toast({ title: "Matched Successfully!", description: `${suggestion.name} has been linked and organized.` });
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
        try {
            const cleanId = manualMatchId.replace('4050-', '').replace(/[^0-9a-zA-Z-]/g, '');
            if (!cleanId) throw new Error("Invalid ID format");

            Logger.log(`[Smart Match Debug] Manual lookup initiated for ID: ${cleanId} via ${searchProvider}`, 'debug');
            
            const res = await fetch(`/api/issue-details?id=${cleanId}&type=volume&provider=${searchProvider}`);
            const data = await res.json();

            if (res.ok && data && !data.error) {
                const suggestionData = {
                    id: data.id || data.volumeId,
                    name: data.name,
                    year: data.year,
                    publisher: data.publisher,
                    image: data.image,
                    count: "?",
                    metadataSource: searchProvider
                };

                if (isBulkManualMatch) {
                    setSuggestions(prev => {
                        const next = { ...prev };
                        selectedItems.forEach(id => {
                            next[id] = suggestionData;
                        });
                        return next;
                    });
                    toast({ title: "Custom ID Applied", description: "Matches set for selected items. Click 'Accept Selected' to confirm and save." });
                } else {
                    setSuggestions(prev => ({
                        ...prev,
                        [manualMatchTarget.id]: suggestionData
                    }));
                    toast({ title: "Match Found", description: "You can now accept the manual match." });
                }
                
                setManualMatchOpen(false);
            } else {
                throw new Error(data.error || "Volume not found");
            }
        } catch (e: any) {
            toast({ title: "Lookup Failed", description: e.message, variant: "destructive" });
        } finally {
            setIsManualMatching(false);
            setIsBulkManualMatch(false);
        }
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
                                    <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">
                                        {series.isRawFile ? 'Loose File' : 'Local Folder'}
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
                                                <div className="flex items-center gap-3 mt-1.5">
                                                    <p className="text-[10px] text-muted-foreground/80">{suggestion.count} Issues</p>
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
                                            setManualMatchId("");
                                        }}
                                    >
                                        <Search className="w-4 h-4 md:mr-2" /> <span className="hidden md:inline">Custom ID</span>
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
                                setManualMatchId("");
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
                <DialogContent className="sm:max-w-md bg-background border-border rounded-xl w-[95%]">
                    <DialogHeader>
                        <DialogTitle>Manual Match</DialogTitle>
                        <DialogDescription>
                            {isBulkManualMatch 
                                ? `Enter the exact ID to apply to the ${selectedItems.size} selected items.`
                                : `Enter the exact ID for ${manualMatchTarget?.name}.`}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4 space-y-4">
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
                            <Input 
                                value={manualMatchId} 
                                onChange={(e) => setManualMatchId(e.target.value)} 
                                placeholder="e.g. 4050-12345 or black-cat-2025"
                                className="bg-background border-border"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1.5">
                                Tip: Search on{" "}
                                <a href="https://comicvine.gamespot.com/volumes/" target="_blank" rel="noreferrer" className="text-primary underline">ComicVine</a> 
                                {" "}or{" "}
                                <a href="https://metron.cloud/series/" target="_blank" rel="noreferrer" className="text-primary underline">Metron</a> 
                                {" "}to find the correct volume/series ID.
                            </p>
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setManualMatchOpen(false)} disabled={isManualMatching} className="border-border hover:bg-muted text-foreground">Cancel</Button>
                        <Button onClick={handleManualLookup} disabled={isManualMatching || !manualMatchId} className="bg-primary text-primary-foreground hover:bg-primary/90 font-bold">
                            {isManualMatching ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />} Look Up ID
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    )
}