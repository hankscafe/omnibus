"use client"

import { useState, useEffect } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Loader2, Sparkles, Check, X, FolderSearch, ArrowRight, Image as ImageIcon, ArrowLeft } from "lucide-react"
import Link from "next/link"

export default function SmartMatchPage() {
    const [unmatched, setUnmatched] = useState<any[]>([]);
    const [suggestions, setSuggestions] = useState<Record<string, any>>({});
    const [isScanning, setIsScanning] = useState(false);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const { toast } = useToast();

    useEffect(() => {
        document.title = "Omnibus - Smart Matcher";
        
        fetch(`/api/admin/unmatched?_t=${Date.now()}`, { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                
                console.log("SMART MATCHER RESPONSE:", data);

                if (!res.ok) {
                    toast({ title: "API Error", description: data.error || "Failed to fetch.", variant: "destructive" });
                }

                if (Array.isArray(data)) {
                    setUnmatched(data);
                } else if (data && data.error) {
                    console.error("Backend returned an error:", data.error);
                }
                
                setLoading(false);
            })
            .catch((err) => {
                console.error("Fetch failed entirely:", err);
                setLoading(false);
            });
    }, []);

    const startSmartScan = async () => {
        setIsScanning(true);
        let matchCount = 0;

        for (const series of unmatched) {
            if (suggestions[series.id]) continue; 

            try {
                const query = `${series.name} ${series.year > 0 ? series.year : ''}`.trim();
                const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
                const data = await res.json();

                if (data.results && data.results.length > 0) {
                    setSuggestions(prev => ({ ...prev, [series.id]: data.results[0] }));
                    matchCount++;
                } else {
                    setSuggestions(prev => ({ ...prev, [series.id]: 'NOT_FOUND' }));
                }
            } catch (e) {
                setSuggestions(prev => ({ ...prev, [series.id]: 'ERROR' }));
            }

            await new Promise(r => setTimeout(r, 1500));
        }

        setIsScanning(false);
        toast({ title: "Scan Complete", description: `Found suggestions for ${matchCount} series.` });
    };

    const handleAcceptMatch = async (series: any, suggestion: any) => {
        setProcessingId(series.id);
        try {
            const res = await fetch('/api/library/match-series', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    oldFolderPath: series.folderPath,
                    cvId: suggestion.id,
                    name: suggestion.name,
                    year: suggestion.year,
                    publisher: suggestion.publisher
                })
            });

            if (res.ok) {
                toast({ title: "Matched Successfully!", description: `${suggestion.name} has been linked and organized.` });
                setUnmatched(prev => prev.filter(s => s.id !== series.id));
            } else {
                const err = await res.json();
                toast({ title: "Match Failed", description: err.error, variant: "destructive" });
            }
        } catch (e) {
            toast({ title: "Error", variant: "destructive" });
        } finally {
            setProcessingId(null);
        }
    };

    const handleDismiss = (id: string) => {
        setUnmatched(prev => prev.filter(s => s.id !== id));
    };

    if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

    return (
        <div className="container mx-auto max-w-5xl py-10 px-6 transition-colors duration-300">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div className="flex items-start gap-4">
                    <Button variant="ghost" size="icon" className="shrink-0 mt-1 text-muted-foreground hover:bg-muted hover:text-foreground" asChild>
                        <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
                    </Button>
                    <div>
                        <h1 className="text-3xl font-extrabold flex items-center gap-3 text-foreground">
                            <Sparkles className="w-8 h-8 text-primary" />
                            Smart Matcher
                        </h1>
                        <p className="text-muted-foreground mt-1">
                            You have {unmatched.length} unmatched folders. Let AI find the metadata for you.
                        </p>
                    </div>
                </div>
                
                <Button onClick={startSmartScan} disabled={isScanning || unmatched.length === 0} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold h-12 px-6 shadow-lg border-0">
                    {isScanning ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Scanning...</> : <><FolderSearch className="w-5 h-5 mr-2" /> Start Auto-Scan</>}
                </Button>
            </div>

            {unmatched.length === 0 ? (
                <div className="text-center py-20 border-2 border-dashed rounded-xl border-border bg-muted/30">
                    <Check className="w-12 h-12 mx-auto text-green-500 mb-3" />
                    <h3 className="text-lg font-bold text-foreground">All Caught Up!</h3>
                    <p className="text-muted-foreground mt-1">Every folder in your library has a valid ComicVine ID.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    {unmatched.map((series) => {
                        const suggestion = suggestions[series.id];
                        const isProcessing = processingId === series.id;

                        return (
                            <Card key={series.id} className={`p-4 flex flex-col md:flex-row items-center gap-6 transition-all border-border bg-background ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}>
                                
                                {/* LOCAL FOLDER DATA */}
                                <div className="flex-1 min-w-[200px] w-full md:w-auto">
                                    <div className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Local Folder</div>
                                    <div className="flex items-start gap-3">
                                        <div className="p-3 bg-muted rounded-lg shrink-0">
                                            <FolderSearch className="w-6 h-6 text-muted-foreground" />
                                        </div>
                                        <div className="overflow-hidden">
                                            <h3 className="font-bold text-foreground truncate" title={series.name}>{series.name}</h3>
                                            <p className="text-sm text-muted-foreground truncate mt-0.5" title={series.folderPath}>{series.folderPath}</p>
                                        </div>
                                    </div>
                                </div>

                                <ArrowRight className="hidden md:block w-6 h-6 text-muted-foreground/30 shrink-0" />

                                {/* COMICVINE SUGGESTION */}
                                <div className="flex-1 min-w-[250px] w-full md:w-auto bg-muted/50 p-3 rounded-xl border border-border">
                                    <div className="text-xs font-bold text-primary uppercase tracking-wider mb-2">ComicVine Suggestion</div>
                                    
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
                                            <div className="overflow-hidden">
                                                <h4 className="font-bold text-foreground truncate text-sm" title={suggestion.name}>{suggestion.name}</h4>
                                                <p className="text-xs text-muted-foreground truncate mt-0.5">{suggestion.publisher || 'Unknown'} • {suggestion.year || '????'}</p>
                                                <p className="text-[10px] text-muted-foreground/80 mt-1">{suggestion.count} Issues</p>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* ACTIONS */}
                                <div className="flex md:flex-col gap-2 shrink-0 w-full md:w-auto justify-end">
                                    <Button 
                                        size="lg" 
                                        className="flex-1 md:flex-none bg-green-600 hover:bg-green-700 text-white font-bold disabled:opacity-50 border-0"
                                        disabled={!suggestion || suggestion === 'NOT_FOUND' || suggestion === 'ERROR'}
                                        onClick={() => handleAcceptMatch(series, suggestion)}
                                    >
                                        <Check className="w-5 h-5 md:mr-2" /> <span className="hidden md:inline">Accept</span>
                                    </Button>
                                    <Button size="icon" variant="outline" className="shrink-0 md:w-full border-border hover:bg-muted text-muted-foreground" onClick={() => handleDismiss(series.id)} title="Hide from Matcher">
                                        <X className="w-5 h-5" />
                                    </Button>
                                </div>

                            </Card>
                        )
                    })}
                </div>
            )}
        </div>
    )
}