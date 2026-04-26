// src/app/calendar/page.tsx
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, Calendar as CalendarIcon, Clock, ChevronLeft, ChevronRight, Image as ImageIcon, BookOpen, Download, Plus, Activity, Check, ExternalLink } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"

interface UpcomingIssue {
    id: string | number;
    seriesId?: string;
    volumeId?: number;
    seriesName: string;
    issueNumber: string;
    issueName?: string;
    publisher: string;
    releaseDate: string;
    coverUrl: string | null;
    seriesPath?: string;
    year?: string;
    metadataSource?: string;
    parsedDay?: string; 
}

export default function CalendarPage() {
    const [activeTab, setActiveTab] = useState("my-pulls");
    const [localIssues, setLocalIssues] = useState<UpcomingIssue[]>([]);
    const [loadingLocal, setLoadingLocal] = useState(true);
    
    // Global Pull List State
    const [globalIssues, setGlobalIssues] = useState<UpcomingIssue[]>([]);
    const [loadingGlobal, setLoadingGlobal] = useState(false);
    const [weekOffset, setWeekOffset] = useState(0);
    const [weekLabel, setWeekLabel] = useState("This Week");
    
    // Request State
    const [requestingTarget, setRequestingTarget] = useState<string | null>(null);
    const [requestedVolumes, setRequestedVolumes] = useState<Set<number>>(new Set());
    const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set());
    const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string, issueNumber: string, metadataSource: string } | null>(null);
    
    const router = useRouter();
    const { toast } = useToast();

    // 1. Fetch Local Calendar
    useEffect(() => {
        document.title = "Omnibus - Release Calendar";
        fetch('/api/calendar')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) setLocalIssues(data);
            })
            .catch(() => {})
            .finally(() => setLoadingLocal(false));
    }, []);

    // 2. Fetch Global Pull List (Metron)
    useEffect(() => {
        if (activeTab !== "global-pulls") return;
        setLoadingGlobal(true);
        fetch(`/api/calendar/global?weekOffset=${weekOffset}`)
            .then(async res => {
                const data = await res.json();
                if (data.error) throw new Error(data.error);
                setGlobalIssues(data.releases || []);
                
                const start = new Date(data.startDate + "T00:00:00Z");
                const end = new Date(data.endDate + "T00:00:00Z");
                setWeekLabel(`${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);
            })
            .catch(e => {
                toast({ title: "Failed to load global releases", description: e.message, variant: "destructive" });
            })
            .finally(() => setLoadingGlobal(false));
    }, [activeTab, weekOffset, toast]);

    // Parse dates for grouping
    const parseDateGroup = (issuesToGroup: UpcomingIssue[]) => {
        return issuesToGroup.reduce((acc, issue) => {
            if (!issue.releaseDate) return acc;
            let monthYear = "TBA";
            let exactDay = "TBA";
            try {
                let safeDate = issue.releaseDate;
                if (safeDate.length === 4) safeDate += "-01-01";
                else if (safeDate.length === 7) safeDate += "-01";
                const dateObj = new Date(`${safeDate}T00:00:00Z`);
                if (!isNaN(dateObj.getTime())) {
                    monthYear = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                    exactDay = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
                }
            } catch(e) {}
            if (!acc[monthYear]) acc[monthYear] = [];
            issue.parsedDay = exactDay;
            acc[monthYear].push(issue);
            return acc;
        }, {} as Record<string, UpcomingIssue[]>);
    };

    const groupedLocalIssues = parseDateGroup(localIssues);
    const groupedGlobalIssues = parseDateGroup(globalIssues);

    // Request & Monitor Logic
    const handleRequest = async (id: number, name: string, image: string, year: string, type: 'volume' | 'issue', publisher: string, monitored: boolean = false, issueNumber?: string, metadataSource: string = 'COMICVINE') => {
        const exactIssueName = name; // Passed exactly as formatted by the caller loop
        const targetKey = type === 'volume' ? `vol-${id}` : `iss-${exactIssueName}`;
        
        setRequestingTarget(targetKey);
        try {
            const res = await fetch('/api/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    cvId: id, name: exactIssueName, year, publisher: publisher || "Unknown", image, type, monitored, metadataSource,
                    issueNumber: issueNumber || (type === 'issue' ? "1" : undefined)
                })
            });

            if (res.ok) {
                toast({ title: "Success", description: `${exactIssueName} added to queue.` });
                if (type === 'volume') setRequestedVolumes(prev => new Set(prev).add(id));
                else setRequestedIssues(prev => new Set(prev).add(exactIssueName));
            }
        } catch (e) {
            toast({ title: "Error", description: "Failed to send request.", variant: "destructive" });
        } finally { 
            setRequestingTarget(null);
            setMonitorPrompt(null);
        }
    };

    return (
        <div className="container mx-auto py-10 px-6 max-w-6xl transition-colors duration-300">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={() => router.back()} className="hover:bg-muted text-foreground">
                        <ChevronLeft className="w-6 h-6" />
                    </Button>
                    <div>
                        <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
                            <CalendarIcon className="w-8 h-8 text-primary" /> Release Calendar
                        </h1>
                        <p className="text-muted-foreground mt-1">Track upcoming releases and pull lists.</p>
                    </div>
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="bg-muted border border-border mb-6">
                    <TabsTrigger value="my-pulls" className="font-bold">Omnibus Tracked Series</TabsTrigger>
                    <TabsTrigger value="global-pulls" className="font-bold">Global Pull List</TabsTrigger>
                </TabsList>

                {/* TAB 1: MY TRACKED SERIES */}
                <TabsContent value="my-pulls" className="space-y-10 animate-in fade-in duration-500">
                    {loadingLocal ? (
                        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
                    ) : Object.keys(groupedLocalIssues).length === 0 ? (
                        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl">
                            <Clock className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
                            <p className="text-lg font-bold text-foreground">No Upcoming Releases</p>
                            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">Omnibus automatically scans for upcoming issues across your entire library.</p>
                            <Button className="mt-4 font-bold bg-primary hover:bg-primary/90 text-primary-foreground" asChild>
                                <Link href="/library">Browse Library</Link>
                            </Button>
                        </div>
                    ) : (
                        Object.entries(groupedLocalIssues).map(([month, monthIssues]) => (
                            <div key={month} className="space-y-4">
                                <h2 className="text-xl font-black text-foreground border-b border-border pb-2 uppercase tracking-widest flex items-center gap-2">
                                    <CalendarIcon className="w-5 h-5 text-muted-foreground" /> {month}
                                </h2>
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                                    {monthIssues.map((issue) => (
                                        <Link key={issue.id} href={`/library/series?path=${encodeURIComponent(issue.seriesPath || '')}`} className="group block h-full">
                                            <Card className="shadow-sm border-border bg-background overflow-hidden h-full flex flex-col">
                                                <div className="relative aspect-[2/3] w-full bg-muted border-b border-border overflow-hidden">
                                                    {issue.coverUrl ? (
                                                        <img src={issue.coverUrl} className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="" />
                                                    ) : (
                                                        <ImageIcon className="w-8 h-8 text-muted-foreground/30 m-auto h-full" />
                                                    )}
                                                    <div className="absolute top-2 right-2 bg-purple-600 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold z-20 uppercase tracking-widest">
                                                        Unreleased
                                                    </div>
                                                    <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10">
                                                        <Button size="sm" className="font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 shadow-lg">
                                                            <BookOpen className="w-4 h-4 mr-2" /> View Series
                                                        </Button>
                                                    </div>
                                                </div>
                                                <CardContent className="p-3 flex-1 flex flex-col justify-between">
                                                    <div>
                                                        <p className="font-bold text-xs truncate text-foreground group-hover:text-primary transition-colors" title={issue.seriesName}>{issue.seriesName}</p>
                                                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">Issue #{issue.issueNumber}</p>
                                                    </div>
                                                    <div className="mt-2 pt-2 border-t border-border">
                                                        <Badge variant="secondary" className="w-full justify-center bg-muted text-muted-foreground border-border text-[10px] font-mono">{issue.parsedDay}</Badge>
                                                    </div>
                                                </CardContent>
                                            </Card>
                                        </Link>
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </TabsContent>

                {/* TAB 2: GLOBAL PULL LIST */}
                <TabsContent value="global-pulls" className="space-y-6 animate-in fade-in duration-500">
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-muted/50 p-4 rounded-xl border border-border">
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => setWeekOffset(w => w - 1)} disabled={loadingGlobal} className="border-border">
                                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setWeekOffset(w => w + 1)} disabled={loadingGlobal} className="border-border">
                                Next <ChevronRight className="w-4 h-4 ml-1" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0 || loadingGlobal} className="font-bold">
                                Today
                            </Button>
                        </div>
                        <div className="flex items-center gap-4 w-full sm:w-auto">
                            <span className="font-mono text-sm font-bold bg-background px-3 py-1.5 rounded-md border border-border">{weekLabel}</span>
                        </div>
                    </div>

                    {loadingGlobal ? (
                        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
                    ) : Object.keys(groupedGlobalIssues).length === 0 ? (
                        <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl">
                            <p className="text-lg font-bold text-foreground">No Releases Found</p>
                            <p className="text-sm text-muted-foreground mt-1">Metron.Cloud returned no data for this week.</p>
                        </div>
                    ) : (
                        Object.entries(groupedGlobalIssues).map(([month, monthIssues]) => (
                            <div key={month} className="space-y-4">
                                <h2 className="text-xl font-black text-foreground border-b border-border pb-2 uppercase tracking-widest flex items-center gap-2">
                                    <CalendarIcon className="w-5 h-5 text-muted-foreground" /> {month}
                                </h2>
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                                    {monthIssues.map((issue) => {
                                        // NEW: Construct the exact composite name of the issue seamlessly 
                                        let compositeName = `${issue.seriesName} #${issue.issueNumber}`;
                                        if (issue.issueName && issue.issueName !== issue.seriesName && !issue.issueName.includes(`#${issue.issueNumber}`)) {
                                            compositeName += `: ${issue.issueName}`;
                                        } else if (issue.issueName && issue.issueName.includes(`#${issue.issueNumber}`)) {
                                            compositeName = issue.issueName;
                                        }

                                        const issueTargetName = compositeName;
                                        const isIssueRequested = requestedIssues.has(issueTargetName);
                                        const isVolRequested = requestedVolumes.has(issue.volumeId!);
                                        const volIdKey = issue.volumeId || 0;

                                        return (
                                        <Card key={issue.id} className="group shadow-sm border-border bg-background overflow-hidden h-full flex flex-col">
                                            <div className="relative aspect-[2/3] w-full bg-muted border-b border-border overflow-hidden">
                                                {issue.coverUrl ? <img src={issue.coverUrl} className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="" /> : <ImageIcon className="w-8 h-8 text-muted-foreground/30 m-auto h-full" />}
                                                
                                                <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center z-10 p-2 gap-2">
                                                    {isVolRequested ? (
                                                        <Button size="sm" variant="secondary" disabled className="w-full font-bold bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 opacity-100">
                                                            <Check className="w-4 h-4 mr-2"/> Subscribed
                                                        </Button>
                                                    ) : (
                                                        <Button 
                                                            size="sm" 
                                                            className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 shadow-lg"
                                                            disabled={requestingTarget === `vol-${volIdKey}`}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                setMonitorPrompt({ id: volIdKey, name: issue.seriesName, image: issue.coverUrl || "", year: issue.year || "", publisher: issue.publisher, issueNumber: issue.issueNumber, metadataSource: (issue as any).metadataSource || 'METRON' })
                                                            }}
                                                        >
                                                            {requestingTarget === `vol-${volIdKey}` ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />} Request Series
                                                        </Button>
                                                    )}

                                                    {isIssueRequested ? (
                                                        <Button size="sm" variant="secondary" disabled className="w-full font-bold bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 opacity-100">
                                                            <Check className="w-4 h-4 mr-2"/> Requested
                                                        </Button>
                                                    ) : (
                                                        <Button 
                                                            size="sm" 
                                                            variant="outline"
                                                            className="w-full font-bold text-white border-white/30 hover:bg-white/20"
                                                            disabled={requestingTarget === `iss-${issueTargetName}` || isVolRequested}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                // Pass the composite name dynamically assembled above
                                                                handleRequest(volIdKey, compositeName, issue.coverUrl || "", issue.year || "", 'issue', issue.publisher, false, issue.issueNumber, (issue as any).metadataSource || 'METRON')
                                                            }}
                                                        >
                                                            {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />} Request Issue
                                                        </Button>
                                                    )}

                                                    <Button 
                                                        size="sm" 
                                                        variant="ghost"
                                                        asChild
                                                        className="w-full font-bold text-white hover:bg-white/20 mt-1"
                                                    >
                                                        <a href={`https://metron.cloud/issue/${issue.id}/`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                                            <ExternalLink className="w-4 h-4 mr-2" /> View Details
                                                        </a>
                                                    </Button>
                                                </div>
                                            </div>
                                            <CardContent className="p-3 flex-1 flex flex-col justify-between">
                                                <div>
                                                    <p className="font-bold text-xs truncate text-foreground" title={issue.seriesName}>{issue.seriesName}</p>
                                                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">Issue #{issue.issueNumber}</p>
                                                </div>
                                                <div className="mt-2 pt-2 border-t border-border">
                                                    <Badge variant="secondary" className="w-full justify-center bg-muted text-muted-foreground border-border text-[10px] font-mono">{issue.parsedDay}</Badge>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    )})}
                                </div>
                            </div>
                        ))
                    )}
                </TabsContent>
            </Tabs>

            {/* MONITOR PROMPT DIALOG */}
            <Dialog open={!!monitorPrompt} onOpenChange={(open) => !open && setMonitorPrompt(null)}>
                <DialogContent className="sm:max-w-md bg-background border-border rounded-xl w-[95%]">
                <DialogHeader>
                    <DialogTitle className="text-xl font-bold text-foreground">Monitor Series?</DialogTitle>
                    <DialogDescription className="text-sm sm:text-base text-muted-foreground mt-2">
                        You are requesting the series <strong>{monitorPrompt?.name}</strong>. Would you like Omnibus to automatically monitor this series and download new issues as they are released in the future?
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 mt-4 sm:mt-6">
                    <Button className="w-full h-12 sm:h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold" onClick={() => {
                        if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, true, monitorPrompt.issueNumber, monitorPrompt.metadataSource);
                        setMonitorPrompt(null);
                    }}>
                        Yes, Subscribe & Monitor
                    </Button>
                    <Button variant="outline" className="w-full h-12 sm:h-10 font-bold border-primary/30 text-primary bg-primary/10 hover:bg-primary/20" onClick={() => {
                        if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, false, monitorPrompt.issueNumber, monitorPrompt.metadataSource);
                        setMonitorPrompt(null);
                    }}>
                        No, Just Request Past Issues
                    </Button>
                    <Button variant="ghost" className="w-full h-12 sm:h-10 font-bold text-muted-foreground" onClick={() => setMonitorPrompt(null)}>Cancel</Button>
                </div>
                </DialogContent>
            </Dialog>

        </div>
    );
}