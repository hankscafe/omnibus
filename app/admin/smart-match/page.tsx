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
        
        // Added cache: 'no-store' and a timestamp to completely defeat Next.js caching
        fetch(`/api/admin/unmatched?_t=${Date.now()}`, { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                
                // LOG THE RAW DATA TO THE CONSOLE SO WE CAN DEBUG!
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
            if (suggestions[series.id]) continue; // Skip if already searched

            try {
                // Combine Name and Year for a highly accurate ComicVine query
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

            // Polite delay to defeat the ComicVine Rate Limiter
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

    if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>;

    return (
        <div className="container mx-auto max-w-5xl py-10 px-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div className="flex items-start gap-4">
                    <Button variant="ghost" size="icon" className="shrink-0 mt-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100" asChild>
                        <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
                    </Button>
                    <div>
                        <h1 className="text-3xl font-extrabold flex items-center gap-3 text-slate-900 dark:text-slate-100">
                            <Sparkles className="w-8 h-8 text-blue-500" />
                            Smart Matcher
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 mt-1">
                            You have {unmatched.length} unmatched folders. Let AI find the metadata for you.
                        </p>
                    </div>
                </div>
                
                <Button onClick={startSmartScan} disabled={isScanning || unmatched.length === 0} className="bg-blue-600 hover:bg-blue-700 text-white font-bold h-12 px-6 shadow-lg">
                    {isScanning ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Scanning ComicVine...</> : <><FolderSearch className="w-5 h-5 mr-2" /> Start Auto-Scan</>}
                </Button>
            </div>

            {unmatched.length === 0 ? (
                <div className="text-center py-20 border-2 border-dashed rounded-xl border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
                    <Check className="w-12 h-12 mx-auto text-green-500 mb-3" />
                    <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">All Caught Up!</h3>
                    <p className="text-slate-500 mt-1">Every folder in your library has a valid ComicVine ID.</p>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    {unmatched.map((series) => {
                        const suggestion = suggestions[series.id];
                        const isProcessing = processingId === series.id;

                        return (
                            <Card key={series.id} className={`p-4 flex flex-col md:flex-row items-center gap-6 transition-all ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}>
                                
                                {/* LOCAL FOLDER DATA */}
                                <div className="flex-1 min-w-[200px] w-full md:w-auto">
                                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Local Folder</div>
                                    <div className="flex items-start gap-3">
                                        <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-lg shrink-0">
                                            <FolderSearch className="w-6 h-6 text-slate-500" />
                                        </div>
                                        <div className="overflow-hidden">
                                            <h3 className="font-bold text-slate-900 dark:text-slate-100 truncate" title={series.name}>{series.name}</h3>
                                            <p className="text-sm text-slate-500 truncate mt-0.5" title={series.folderPath}>{series.folderPath}</p>
                                        </div>
                                    </div>
                                </div>

                                <ArrowRight className="hidden md:block w-6 h-6 text-slate-300 dark:text-slate-700 shrink-0" />

                                {/* COMICVINE SUGGESTION */}
                                <div className="flex-1 min-w-[250px] w-full md:w-auto bg-slate-50 dark:bg-slate-900/50 p-3 rounded-xl border dark:border-slate-800">
                                    <div className="text-xs font-bold text-blue-500 uppercase tracking-wider mb-2">ComicVine Suggestion</div>
                                    
                                    {!suggestion && isScanning && (
                                        <div className="flex items-center gap-3 text-slate-500 animate-pulse py-2">
                                            <Loader2 className="w-5 h-5 animate-spin" /> Searching...
                                        </div>
                                    )}
                                    {!suggestion && !isScanning && (
                                        <div className="text-sm text-slate-500 italic py-2">Click 'Start Auto-Scan' above to search.</div>
                                    )}
                                    {suggestion === 'NOT_FOUND' && (
                                        <div className="text-sm text-orange-500 font-medium py-2">No confident match found.</div>
                                    )}
                                    {suggestion === 'ERROR' && (
                                        <div className="text-sm text-red-500 font-medium py-2">Search failed. Rate limit hit?</div>
                                    )}
                                    {suggestion && suggestion !== 'NOT_FOUND' && suggestion !== 'ERROR' && (
                                        <div className="flex gap-3 items-center">
                                            <div className="w-12 h-16 shrink-0 rounded bg-slate-200 dark:bg-slate-800 overflow-hidden border dark:border-slate-700">
                                                {suggestion.image ? <img src={suggestion.image} className="w-full h-full object-cover" /> : <ImageIcon className="w-4 h-4 m-auto mt-6 text-slate-400" />}
                                            </div>
                                            <div className="overflow-hidden">
                                                <h4 className="font-bold text-slate-900 dark:text-slate-100 truncate text-sm" title={suggestion.name}>{suggestion.name}</h4>
                                                <p className="text-xs text-slate-500 truncate mt-0.5">{suggestion.publisher || 'Unknown'} • {suggestion.year || '????'}</p>
                                                <p className="text-[10px] text-slate-400 mt-1">{suggestion.count} Issues</p>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* ACTIONS */}
                                <div className="flex md:flex-col gap-2 shrink-0 w-full md:w-auto justify-end">
                                    <Button 
                                        size="lg" 
                                        className="flex-1 md:flex-none bg-green-600 hover:bg-green-700 text-white font-bold disabled:opacity-50"
                                        disabled={!suggestion || suggestion === 'NOT_FOUND' || suggestion === 'ERROR'}
                                        onClick={() => handleAcceptMatch(series, suggestion)}
                                    >
                                        <Check className="w-5 h-5 md:mr-2" /> <span className="hidden md:inline">Accept</span>
                                    </Button>
                                    <Button size="icon" variant="outline" className="shrink-0 md:w-full" onClick={() => handleDismiss(series.id)} title="Hide from Matcher">
                                        <X className="w-5 h-5 text-slate-400" />
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