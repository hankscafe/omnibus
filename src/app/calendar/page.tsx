// src/app/calendar/page.tsx
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, Calendar as CalendarIcon, Clock, ChevronLeft, ChevronRight, Image as ImageIcon, BookOpen, Download, Plus, Activity, Check, ExternalLink, Eye } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useSession } from "next-auth/react"
import { FollowBell } from "@/components/follow-bell"

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
    monitored?: boolean;
    inLibrary?: boolean;
    libraryState?: 'UNRELEASED' | 'RELEASED' | 'IN_LIBRARY';
}

export default function CalendarPage() {
    const { data: session, status } = useSession();
    const isAdmin = session?.user?.role === 'ADMIN';
    const canRequest = isAdmin || (session?.user as any)?.canRequest;

    const [activeTab, setActiveTab] = useState("my-pulls");
    const [metronConfigured, setMetronConfigured] = useState<boolean | null>(null);
    
    // Local Tracked State
    const [localIssues, setLocalIssues] = useState<UpcomingIssue[]>([]);
    const [loadingLocal, setLoadingLocal] = useState(true);
    const [localWeekOffset, setLocalWeekOffset] = useState(0);
    const [localWeekLabel, setLocalWeekLabel] = useState("This Week");
    
    // Global Pull List State
    const [globalIssues, setGlobalIssues] = useState<UpcomingIssue[]>([]);
    const [loadingGlobal, setLoadingGlobal] = useState(false);
    const [weekOffset, setWeekOffset] = useState(0);
    const [weekLabel, setWeekLabel] = useState("This Week");
    
    // Request State
    const [requestingTarget, setRequestingTarget] = useState<string | null>(null);
    const [requestedVolumes, setRequestedVolumes] = useState<Set<number>>(new Set());
    const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set());

    // Per-user followed set (Beta C): decorates tracked-series cards with follow bells.
    const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
    useEffect(() => {
        fetch('/api/library/follow')
            .then(res => res.ok ? res.json() : { seriesIds: [] })
            .then(data => setFollowedIds(new Set(data.seriesIds || [])))
            .catch(() => {});
    }, []);
    const handleFollowToggled = (seriesId: string, isFollowing: boolean) => {
        setFollowedIds(prev => {
            const next = new Set(prev);
            if (isFollowing) next.add(seriesId); else next.delete(seriesId);
            return next;
        });
    };
    const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string, issueNumber: string, metadataSource: string } | null>(null);
    
    const router = useRouter();
    const { toast } = useToast();

    // 0. Check if Metron is configured
    useEffect(() => {
        if (status === "loading") return;

        if (isAdmin) {
            fetch('/api/admin/config')
                .then(res => res.ok ? res.json() : null)
                .then(data => {
                    if (data?.settings) {
                        const mUser = data.settings.find((s: any) => s.key === 'metron_user')?.value;
                        const mPass = data.settings.find((s: any) => s.key === 'metron_pass')?.value;
                        setMetronConfigured(!!(mUser && mPass));
                    } else {
                        setMetronConfigured(true);
                    }
                })
                .catch(() => setMetronConfigured(true));
        } else {
            fetch('/api/calendar/global?weekOffset=0')
                .then(res => res.json())
                .then(data => {
                    if (data.error && data.error.includes("Metron credentials missing")) {
                        setMetronConfigured(false);
                    } else {
                        setMetronConfigured(true);
                    }
                })
                .catch(() => setMetronConfigured(true));
        }
    }, [isAdmin, status]);

    // 1. Fetch Local Calendar
    useEffect(() => {
        if (metronConfigured !== true) return;
        if (activeTab !== "my-pulls") return;
        setLoadingLocal(true);
        document.title = "Omnibus - Release Calendar";
        fetch(`/api/calendar?weekOffset=${localWeekOffset}`)
            .then(res => res.json())
            .then(data => {
                if (data.releases) {
                    setLocalIssues(data.releases);
                    const start = new Date(data.startDate + "T00:00:00Z");
                    const end = new Date(data.endDate + "T00:00:00Z");
                    setLocalWeekLabel(`${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);
                }
            })
            .catch(() => {})
            .finally(() => setLoadingLocal(false));
    }, [activeTab, localWeekOffset, metronConfigured]);

    // 2. Fetch Global Pull List (Metron)
    useEffect(() => {
        if (metronConfigured !== true) return;
        if (activeTab !== "global-pulls") return;
        setLoadingGlobal(true);
        fetch(`/api/calendar/global?weekOffset=${weekOffset}`)
            .then(res => res.json())
            .then(data => {
                if (data.releases) {
                    setGlobalIssues(data.releases);
                    const start = new Date(data.startDate + "T00:00:00Z");
                    const end = new Date(data.endDate + "T00:00:00Z");
                    setWeekLabel(`${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);
                }
            })
            .catch(() => {})
            .finally(() => setLoadingGlobal(false));
    }, [activeTab, weekOffset, metronConfigured]);

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

    const handleRequest = async (id: number | string, name: string, image: string, year: string, type: 'volume' | 'issue', publisher: string, monitored: boolean = false, issueNumber?: string, metadataSource: string = 'COMICVINE', monitorOnly: boolean = false, releaseDate?: string) => {
        const exactIssueName = name; 
        const targetKey = type === 'volume' ? `vol-${id}` : `iss-${exactIssueName}`;

        if (!canRequest) {
            toast({ title: "Requests not enabled", description: "Ask an admin to grant you the Request permission.", variant: "destructive" });
            return;
        }
        setRequestingTarget(targetKey);
        try {
            const res = await fetch('/api/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    cvId: id, name: exactIssueName, year, publisher: publisher || "Unknown", image, type, monitored, metadataSource,
                    issueNumber: issueNumber || (type === 'issue' ? "1" : undefined),
                    monitorOnly,
                    releaseDate
                })
            });

            if (res.ok) {
                const data = await res.json();
                toast({ title: "Success", description: data.message || `${exactIssueName} added to queue.` });
                
                if (type === 'volume') {
                    if (!monitorOnly) {
                        setRequestedVolumes(prev => new Set(prev).add(Number(id)));
                    }
                } else {
                    setRequestedIssues(prev => new Set(prev).add(exactIssueName));
                }
            } else {
                const errData = await res.json().catch(() => ({}));
                toast({ title: "Request Failed", description: errData.error || "Server returned an error.", variant: "destructive" });
            }
        } catch (e) {
            toast({ title: "Error", description: "Failed to send request.", variant: "destructive" });
        } finally { 
            setRequestingTarget(null);
            setMonitorPrompt(null);
        }
    };

    if (metronConfigured === null) {
        return (
            <div className="container mx-auto py-20 px-6 max-w-6xl transition-colors duration-300">
                <div className="flex justify-center py-20">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
            </div>
        );
    }

    if (metronConfigured === false) {
        return (
            <div className="container mx-auto py-20 px-6 max-w-4xl transition-colors duration-300">
                <Card className="shadow-sm border-border bg-background text-center py-16 px-6">
                    <CalendarIcon className="w-16 h-16 mx-auto text-muted-foreground/30 mb-6" />
                    <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-3">Integration Required</h2>
                    <p className="text-muted-foreground max-w-lg mx-auto mb-8">
                        To use the Release Calendar, the Metron.Cloud integration must be configured. Omnibus uses Metron to accurately track upcoming weekly comic release dates.
                    </p>
                    {isAdmin ? (
                        <Button asChild className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-8 h-12">
                            <Link href="/admin/settings">Configure Metron.Cloud</Link>
                        </Button>
                    ) : (
                        <p className="text-sm font-bold text-primary bg-primary/10 py-3 px-6 rounded-lg inline-block">
                            Please ask your server administrator to configure this integration in Settings.
                        </p>
                    )}
                </Card>
            </div>
        );
    }

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
                <TabsContent value="my-pulls" className="space-y-6 animate-in fade-in duration-300">
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-muted/50 p-4 rounded-xl border border-border">
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => setLocalWeekOffset(w => w - 1)} disabled={loadingLocal} className="border-border">
                                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setLocalWeekOffset(w => w + 1)} disabled={loadingLocal} className="border-border">
                                Next <ChevronRight className="w-4 h-4 ml-1" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setLocalWeekOffset(0)} disabled={localWeekOffset === 0 || loadingLocal} className="font-bold">
                                Today
                            </Button>
                        </div>
                        <div className="flex items-center gap-4 w-full sm:w-auto">
                            <span className="font-mono text-sm font-bold bg-background px-3 py-1.5 rounded-md border border-border">{localWeekLabel}</span>
                        </div>
                    </div>

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
                                            <Card className="shadow-sm border-border bg-background overflow-hidden h-full flex flex-col hover:border-primary/50 transition-colors duration-200">
                                                <div className="relative aspect-[2/3] w-full bg-muted border-b border-border overflow-hidden">
                                                    {issue.coverUrl ? (
                                                        <img src={issue.coverUrl} className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="" />
                                                    ) : (
                                                        <ImageIcon className="w-8 h-8 text-muted-foreground/30 m-auto h-full" />
                                                    )}
                                                    {issue.seriesId && (
                                                        <div className="absolute top-2 left-2 z-20">
                                                            <FollowBell seriesId={issue.seriesId} seriesName={issue.seriesName} isFollowing={followedIds.has(issue.seriesId)} onToggled={handleFollowToggled} className="h-7 w-7 bg-black/50 hover:bg-black/70 border-0 text-white" />
                                                        </div>
                                                    )}
                                                    {issue.libraryState === 'IN_LIBRARY' ? (
                                                        <div className="absolute top-2 right-2 bg-emerald-500 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold z-20 uppercase tracking-widest shadow-md">
                                                            In Library
                                                        </div>
                                                    ) : issue.libraryState === 'RELEASED' ? (
                                                        <div className="absolute top-2 right-2 bg-amber-500 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold z-20 uppercase tracking-widest shadow-md">
                                                            Released
                                                        </div>
                                                    ) : (
                                                        <div className="absolute top-2 right-2 bg-purple-600 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold z-20 uppercase tracking-widest">
                                                            Unreleased
                                                        </div>
                                                    )}
                                                    
                                                    {/* Hidden on mobile to prevent overlay flash issues, visible on desktop hover */}
                                                    <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity duration-200 hidden sm:flex items-center justify-center z-10 pointer-events-none">
                                                        <Button size="sm" className="font-bold shadow-md pointer-events-auto" tabIndex={-1}>
                                                            <Eye className="w-3 h-3 mr-2" /> View Series
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
                <TabsContent value="global-pulls" className="space-y-6 animate-in fade-in duration-300">
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
                                        let compositeName = `${issue.seriesName} #${issue.issueNumber}`;
                                        if (issue.issueName && issue.issueName !== issue.seriesName && !issue.issueName.includes(`#${issue.issueNumber}`)) {
                                            compositeName += `: ${issue.issueName}`;
                                        } else if (issue.issueName && issue.issueName.includes(`#${issue.issueNumber}`)) {
                                            compositeName = issue.issueName;
                                        }

                                        const issueTargetName = compositeName;
                                        const isIssueRequested = requestedIssues.has(issueTargetName);
                                        const volIdKey = issue.volumeId || 0;
                                        const isVolRequested = requestedVolumes.has(Number(volIdKey));
                                        
                                        const isMonitored = issue.monitored || isVolRequested;
                                        const inLibrary = issue.inLibrary || isVolRequested;

                                        return (
                                        <Card key={issue.id} className="group shadow-sm border-border bg-background overflow-hidden h-full flex flex-col hover:border-primary/50 transition-colors duration-200">
                                            <div className="relative aspect-[2/3] w-full bg-muted border-b border-border overflow-hidden">
                                                {issue.coverUrl ? <img src={issue.coverUrl} className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300" alt="" /> : <ImageIcon className="w-8 h-8 text-muted-foreground/30 m-auto h-full" />}
                                                
                                                {/* Status Badges */}
                                                <div className="absolute top-2 left-2 flex flex-col gap-1 z-20 pointer-events-none">
                                                    {isMonitored ? (
                                                        <div className="bg-emerald-500 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest shadow-md">
                                                            Monitored
                                                        </div>
                                                    ) : inLibrary ? (
                                                        <div className="bg-blue-500 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest shadow-md">
                                                            Series in Library
                                                        </div>
                                                    ) : null}
                                                </div>

                                                {/* Desktop Only Hover Overlay */}
                                                <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity duration-200 hidden sm:flex flex-col items-center justify-center z-10 p-2 gap-1.5">
                                                    {isMonitored ? (
                                                        <>
                                                            <Button size="sm" variant="secondary" disabled className="w-full text-[10px] font-bold whitespace-nowrap uppercase tracking-wider bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-2 border-white h-8 opacity-100 shadow-md">
                                                                <Check className="w-3 h-3 mr-1"/> {inLibrary ? "Monitored" : "Subscribed"}
                                                            </Button>
                                                            <div className="flex flex-col gap-1.5 w-full">
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    disabled
                                                                    className="text-[10px] font-bold whitespace-nowrap uppercase tracking-wider text-white border-2 border-white/50 h-8 opacity-50 cursor-not-allowed"
                                                                >
                                                                    <Download className="w-3 h-3 mr-1"/> Request Issue
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    asChild
                                                                    className="text-[10px] font-bold whitespace-nowrap uppercase tracking-wider text-white border-2 border-white/50 hover:bg-white/20 h-8"
                                                                >
                                                                    <a href={`https://metron.cloud/issue/${issue.id}/`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                                                        <ExternalLink className="w-3 h-3 mr-1"/> Details
                                                                    </a>
                                                                </Button>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <div className="flex flex-col gap-1.5 w-full">
                                                                <Button
                                                                    size="sm"
                                                                    className="text-[10px] font-bold whitespace-nowrap uppercase tracking-wider bg-primary hover:bg-primary/90 text-primary-foreground border-2 border-white h-8"
                                                                    disabled={requestingTarget === `vol-${volIdKey}`}
                                                                    onClick={(e) => {
                                                                        e.preventDefault();
                                                                        e.stopPropagation();
                                                                        setMonitorPrompt({ id: volIdKey, name: issue.seriesName, image: issue.coverUrl || "", year: issue.year || "", publisher: issue.publisher, issueNumber: issue.issueNumber, metadataSource: (issue as any).metadataSource || 'METRON' })
                                                                    }}
                                                                >
                                                                    {requestingTarget === `vol-${volIdKey}` ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />} Request Series
                                                                </Button>
                                                                {isIssueRequested ? (
                                                                    <Button size="sm" variant="secondary" disabled className="text-[10px] font-bold whitespace-nowrap uppercase tracking-wider bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-2 border-white h-8 opacity-100 shadow-md">
                                                                        <Check className="w-3 h-3 mr-1"/> Requested
                                                                    </Button>
                                                                ) : (
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        className="text-[10px] font-bold whitespace-nowrap uppercase tracking-wider text-white border-2 border-white h-8 hover:bg-white/20"
                                                                        disabled={requestingTarget === `iss-${issueTargetName}`}
                                                                        onClick={(e) => {
                                                                            e.preventDefault();
                                                                            e.stopPropagation();
                                                                            handleRequest(volIdKey, compositeName, issue.coverUrl || "", issue.year || "", 'issue', issue.publisher, false, issue.issueNumber, (issue as any).metadataSource || 'METRON', false, issue.releaseDate)
                                                                        }}
                                                                    >
                                                                        {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Download className="w-3 h-3 mr-1" />} Request Issue
                                                                    </Button>
                                                                )}
                                                            </div>
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                asChild
                                                                className="w-full text-[10px] font-bold whitespace-nowrap uppercase tracking-wider text-white border-2 border-white/50 hover:bg-white/20 h-7"
                                                            >
                                                                <a href={`https://metron.cloud/issue/${issue.id}/`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                                                    <ExternalLink className="w-3 h-3 mr-1" /> View Details
                                                                </a>
                                                            </Button>
                                                        </>
                                                    )}
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

                                                {/* Mobile Always-Visible Buttons */}
                                                <div className="flex sm:hidden flex-col gap-1.5 mt-3 pt-3 border-t border-border">
                                                    {isMonitored ? (
                                                        <Button size="sm" variant="secondary" disabled className="w-full text-[10px] font-bold bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 opacity-100 h-8">
                                                            <Check className="w-3 h-3 mr-1.5"/> {inLibrary ? "Monitored" : "Subscribed"}
                                                        </Button>
                                                    ) : (
                                                        <Button 
                                                            size="sm" 
                                                            className="w-full text-[10px] font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 shadow-sm h-8"
                                                            disabled={requestingTarget === `vol-${volIdKey}`}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                setMonitorPrompt({ id: volIdKey, name: issue.seriesName, image: issue.coverUrl || "", year: issue.year || "", publisher: issue.publisher, issueNumber: issue.issueNumber, metadataSource: (issue as any).metadataSource || 'METRON' })
                                                            }}
                                                        >
                                                            {requestingTarget === `vol-${volIdKey}` ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Plus className="w-3 h-3 mr-1.5" />} Request Series
                                                        </Button>
                                                    )}

                                                    {isIssueRequested ? (
                                                        <Button size="sm" variant="secondary" disabled className="w-full text-[10px] font-bold bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 opacity-100 h-8">
                                                            <Check className="w-3 h-3 mr-1.5"/> Requested
                                                        </Button>
                                                    ) : (
                                                        <Button 
                                                            size="sm" 
                                                            variant="outline"
                                                            className="w-full text-[10px] font-bold text-primary border-primary/30 bg-primary/10 hover:bg-primary/20 h-8"
                                                            disabled={requestingTarget === `iss-${issueTargetName}` || isMonitored}
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                handleRequest(volIdKey, compositeName, issue.coverUrl || "", issue.year || "", 'issue', issue.publisher, false, issue.issueNumber, (issue as any).metadataSource || 'METRON', false, issue.releaseDate)
                                                            }}
                                                        >
                                                            {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Download className="w-3 h-3 mr-1.5" />} Request Issue
                                                        </Button>
                                                    )}

                                                    <Button 
                                                        size="sm" 
                                                        variant="ghost"
                                                        asChild
                                                        className="w-full text-[10px] font-bold text-muted-foreground hover:text-foreground hover:bg-muted h-8"
                                                    >
                                                        <a href={`https://metron.cloud/issue/${issue.id}/`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                                            <ExternalLink className="w-3 h-3 mr-1.5" /> Details
                                                        </a>
                                                    </Button>
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
                        // --- FIX: Pass monitorOnly: false so it acts as "Request & Monitor" ---
                        if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, true, monitorPrompt.issueNumber, monitorPrompt.metadataSource, false); 
                        setMonitorPrompt(null);
                    }}>
                        Yes, Request & Monitor
                    </Button>
                    <Button variant="outline" className="w-full h-12 sm:h-10 font-bold border-primary/30 text-primary bg-primary/10 hover:bg-primary/20" onClick={() => {
                        if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, false, monitorPrompt.issueNumber, monitorPrompt.metadataSource, false); 
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