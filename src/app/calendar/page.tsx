// src/app/calendar/page.tsx
"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Calendar as CalendarIcon, Clock, ChevronLeft, Image as ImageIcon, BookOpen } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"

interface UpcomingIssue {
    id: string;
    seriesId: string;
    seriesName: string;
    issueNumber: string;
    issueName: string;
    publisher: string;
    releaseDate: string;
    coverUrl: string | null;
    seriesPath: string;
    parsedDay?: string; // Appended during processing
}

export default function CalendarPage() {
    const [issues, setIssues] = useState<UpcomingIssue[]>([]);
    const [loading, setLoading] = useState(true);
    const router = useRouter();

    useEffect(() => {
        document.title = "Omnibus - Release Calendar";
        fetch('/api/calendar')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) setIssues(data);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    // Group issues by Month/Year (e.g., "October 2026")
    const groupedIssues = issues.reduce((acc, issue) => {
        if (!issue.releaseDate) return acc;
        
        let monthYear = "TBA";
        let exactDay = "TBA";
        
        try {
            // Force UTC and handle malformed dates from ComicVine (e.g. "2024-05" instead of "2024-05-01")
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
        
        // Attach the parsed day so we don't have to calculate it again in the render loop
        issue.parsedDay = exactDay;
        acc[monthYear].push(issue);
        
        return acc;
    }, {} as Record<string, UpcomingIssue[]>);

    if (loading) {
        return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
    }

    return (
        <div className="container mx-auto py-10 px-6 max-w-6xl transition-colors duration-300">
            <div className="flex items-center gap-4 mb-8">
                <Button variant="ghost" size="icon" onClick={() => router.back()} className="hover:bg-muted text-foreground">
                    <ChevronLeft className="w-6 h-6" />
                </Button>
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
                        <CalendarIcon className="w-8 h-8 text-primary" /> Release Calendar
                    </h1>
                    <p className="text-muted-foreground mt-1">Upcoming releases across your entire library.</p>
                </div>
            </div>

            {Object.keys(groupedIssues).length === 0 ? (
                <div className="text-center py-20 border-2 border-dashed border-border bg-muted/30 rounded-xl">
                    <Clock className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
                    <p className="text-lg font-bold text-foreground">No Upcoming Releases</p>
                    <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">Omnibus automatically scans for upcoming issues across your entire library. Check back later!</p>
                    <Button className="mt-4 font-bold bg-primary hover:bg-primary/90 text-primary-foreground" asChild>
                        <Link href="/library">Browse Library</Link>
                    </Button>
                </div>
            ) : (
                <div className="space-y-10">
                    {Object.entries(groupedIssues).map(([month, monthIssues]) => (
                        <div key={month} className="space-y-4">
                            <h2 className="text-xl font-black text-foreground border-b border-border pb-2 uppercase tracking-widest flex items-center gap-2">
                                <CalendarIcon className="w-5 h-5 text-muted-foreground" /> {month}
                            </h2>
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                                {monthIssues.map((issue) => (
                                    <Link 
                                        key={issue.id} 
                                        href={`/library/series?path=${encodeURIComponent(issue.seriesPath)}`}
                                        className="group block"
                                    >
                                        <Card className="shadow-sm border-border bg-background overflow-hidden h-full transition-all group-hover:border-primary/50 group-hover:shadow-md">
                                            <div className="relative aspect-[2/3] w-full bg-muted border-b border-border">
                                                {issue.coverUrl ? (
                                                    <img src={issue.coverUrl} className="w-full h-full object-cover" alt="" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
                                                    </div>
                                                )}
                                                
                                                <div className="absolute top-2 right-2 bg-purple-600 text-white rounded-md px-1.5 py-0.5 text-[9px] font-bold z-20 shadow-sm border border-white/20 uppercase tracking-widest">
                                                    Unreleased
                                                </div>

                                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10">
                                                    <Button size="sm" className="font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 shadow-lg">
                                                        <BookOpen className="w-4 h-4 mr-2" /> View Series
                                                    </Button>
                                                </div>
                                            </div>
                                            <CardContent className="p-3">
                                                <p className="font-bold text-xs truncate text-foreground group-hover:text-primary transition-colors" title={issue.seriesName}>{issue.seriesName}</p>
                                                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-0.5">Issue #{issue.issueNumber}</p>
                                                <div className="mt-2 pt-2 border-t border-border">
                                                    <Badge variant="secondary" className="w-full justify-center bg-muted text-muted-foreground border-border text-[10px] font-mono">
                                                        {issue.parsedDay}
                                                    </Badge>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </Link>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}