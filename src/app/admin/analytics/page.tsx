"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ArrowLeft, BarChart3, PieChart as PieIcon, Activity, Loader2, Clock, RefreshCw, TrendingUp, Archive, Trash2, AlertTriangle } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { 
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
    PieChart, Pie, Cell, LineChart, Line, Legend 
} from "recharts"

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#6366f1'];

export default function AnalyticsPage() {
    const [data, setData] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    
    // Purge State
    const [isPurging, setIsPurging] = useState(false);
    const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
    const [purgeInput, setPurgeInput] = useState(""); 
    
    const { toast } = useToast();

    const fetchAnalytics = async (isManual = false) => {
        if (isManual) setRefreshing(true);
        else setLoading(true);

        try {
            const res = await fetch('/api/admin/analytics');
            const d = await res.json();
            setData(d);
            if (isManual) {
                toast({ title: "Analytics Updated", description: "All metrics have been recalculated." });
            }
        } catch (e) {
            toast({ title: "Fetch Failed", variant: "destructive", description: "Could not retrieve latest analytics." });
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        document.title = "Omnibus - Insights";
        fetchAnalytics();
    }, []);

    const handlePurgeInactive = async () => {
        if (!data?.inactiveSeries?.length) return;
        setIsPurging(true);
        
        try {
            const seriesIds = data.inactiveSeries.map((s: any) => s.id);
            const res = await fetch('/api/library/series', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seriesIds, deleteFiles: true }) 
            });

            if (res.ok) {
                toast({ title: "Purged Successfully", description: `Removed ${seriesIds.length} inactive series.` });
                setPurgeConfirmOpen(false);
                setPurgeInput(""); 
                fetchAnalytics(true); 
            } else {
                throw new Error("Failed to purge series");
            }
        } catch (e: any) {
            toast({ title: "Purge Failed", description: e.message, variant: "destructive" });
        } finally {
            setIsPurging(false);
        }
    }

    if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>;
    
    if (!data) return <div className="text-center py-20 text-muted-foreground">Failed to load analytics data.</div>;

    return (
        <div className="container mx-auto max-w-6xl py-10 px-6 space-y-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" asChild><Link href="/admin"><ArrowLeft /></Link></Button>
                    <h1 className="text-3xl font-bold">Analytics & Insights</h1>
                </div>
                
                <div className="flex items-center gap-3 self-start md:self-center">
                    {data.timestamp && (
                        <Badge variant="outline" className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800">
                            <Clock className="w-3 h-3" />
                            Updated: {new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Badge>
                    )}
                    <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => fetchAnalytics(true)} 
                        disabled={refreshing}
                        className="h-8 px-3"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
                        Refresh Data
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* CHART 1: STORAGE USAGE (CLICKABLE LINK TO DEEP DIVE) */}
                <Link href="/admin/storage" className="block transition-transform hover:scale-[1.02] active:scale-[0.98] rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-slate-950">
                    <Card className="shadow-sm h-full border-2 border-transparent hover:border-indigo-100 dark:hover:border-indigo-900/50 transition-colors cursor-pointer group">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <PieIcon className="w-5 h-5 text-blue-500"/> Storage by Publisher
                            </CardTitle>
                            <CardDescription>
                                Visualizing disk space (GB) across your library. <span className="font-semibold text-indigo-600 dark:text-indigo-400 group-hover:underline ml-1">Click for Deep Storage Scan &rarr;</span>
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="h-80">
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie 
                                        data={data?.storageData || []} 
                                        cx="50%" cy="50%" 
                                        innerRadius={60} 
                                        outerRadius={80} 
                                        paddingAngle={5} 
                                        dataKey="value"
                                        animationDuration={1000}
                                    >
                                        {(data?.storageData || []).map((entry: any, index: number) => (
                                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                        ))}
                                    </Pie>
                                    <Tooltip />
                                    <Legend />
                                </PieChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </Link>

                {/* CHART 2: SERVER FAVORITES */}
                <Card className="shadow-sm">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2"><TrendingUp className="w-5 h-5 text-pink-500"/> Server Favorites</CardTitle>
                        <CardDescription>Top 5 series by total global completed issues.</CardDescription>
                    </CardHeader>
                    <CardContent className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data?.popularSeriesData || []} layout="vertical" margin={{ left: 40, right: 20 }}>
                                <CartesianGrid strokeDasharray="3 3" horizontal={false} opacity={0.2} />
                                <XAxis type="number" hide />
                                <YAxis dataKey="name" type="category" width={100} tick={{fontSize: 10}} axisLine={false} tickLine={false} />
                                <Tooltip cursor={{fill: 'transparent'}} />
                                <Bar dataKey="completedCount" fill="#ec4899" radius={[0, 4, 4, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>

                {/* CHART 3: SYSTEM HEALTH */}
                <Card className="shadow-sm">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2"><Activity className="w-5 h-5 text-green-500"/> Job Health (30 Days)</CardTitle>
                        <CardDescription>Success vs failure rates of background tasks.</CardDescription>
                    </CardHeader>
                    <CardContent className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={data?.healthData || []}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.1} />
                                <XAxis dataKey="date" axisLine={false} tickLine={false} fontSize={10} />
                                <YAxis axisLine={false} tickLine={false} fontSize={10} />
                                <Tooltip />
                                <Legend />
                                <Line type="monotone" dataKey="success" stroke="#10b981" strokeWidth={3} dot={false} />
                                <Line type="monotone" dataKey="fail" stroke="#ef4444" strokeWidth={3} dot={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>

                {/* CHART 4: USER ENGAGEMENT */}
                <Card className="shadow-sm">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2"><BarChart3 className="w-5 h-5 text-purple-500"/> Top Reader Activity</CardTitle>
                        <CardDescription>Active users by total completed issues.</CardDescription>
                    </CardHeader>
                    <CardContent className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={data?.engagementData || []}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.2} />
                                <XAxis dataKey="name" axisLine={false} tickLine={false} fontSize={10} />
                                <YAxis axisLine={false} tickLine={false} fontSize={10} />
                                <Tooltip cursor={{fill: 'transparent'}} />
                                <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>

                {/* SECTION 5: INACTIVE SERIES REPORT */}
                <Card className="shadow-sm lg:col-span-2 border-red-100 dark:border-red-900/30">
                    <CardHeader className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                        <div className="space-y-1.5">
                            <CardTitle className="flex items-center gap-2"><Archive className="w-5 h-5 text-slate-500"/> Inactive Series Report</CardTitle>
                            <CardDescription>Series with zero read activity. Potential candidates for removal.</CardDescription>
                        </div>
                        {(data?.inactiveSeries || []).length > 0 && (
                            <Button variant="destructive" onClick={() => setPurgeConfirmOpen(true)} disabled={isPurging}>
                                {isPurging ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                                Purge Inactive ({data.inactiveSeries.length})
                            </Button>
                        )}
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {(data?.inactiveSeries || []).length > 0 ? (
                                data.inactiveSeries.map((s: any, i: number) => (
                                    <div key={i} className="flex items-center justify-between p-3 rounded-lg border bg-slate-50/50 dark:bg-slate-900/50 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
                                        <div className="overflow-hidden">
                                            <p className="font-bold text-sm truncate">{s.name}</p>
                                            <p className="text-[10px] text-muted-foreground uppercase">{s.publisher}</p>
                                        </div>
                                        <Badge variant="secondary" className="text-[9px]">Inactive</Badge>
                                    </div>
                                ))
                            ) : (
                                <div className="col-span-2 py-6 text-center text-sm text-muted-foreground italic">
                                    No inactive series found. Every comic has been read recently!
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* HIGH SECURITY PURGE MODAL */}
            <Dialog open={purgeConfirmOpen} onOpenChange={(open) => {
                setPurgeConfirmOpen(open);
                if (!open) setPurgeInput(""); 
            }}>
                <DialogContent className="sm:max-w-md dark:bg-slate-950 dark:border-slate-800 border-red-200 dark:border-red-900">
                    <DialogHeader>
                        <DialogTitle className="text-red-600 dark:text-red-500 flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5" /> Mass Deletion Warning
                        </DialogTitle>
                        <DialogDescription className="pt-3 leading-relaxed">
                            Are you absolutely sure you want to delete these <strong>{(data?.inactiveSeries || []).length}</strong> inactive series? 
                            <br/><br/>
                            This will completely wipe them from the database <strong>AND permanently delete the physical files</strong> from your server storage. This action cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    
                    <div className="py-4 space-y-3">
                        <Label className="text-sm font-bold text-slate-700 dark:text-slate-300">
                            Type <span className="text-red-600 bg-red-50 dark:bg-red-950/50 dark:text-red-400 font-mono px-1.5 py-0.5 rounded border border-red-200 dark:border-red-900">PURGE ALL</span> to confirm:
                        </Label>
                        <Input 
                            value={purgeInput} 
                            onChange={(e) => setPurgeInput(e.target.value)} 
                            placeholder="PURGE ALL"
                            className="font-mono border-red-200 focus-visible:ring-red-500 dark:border-red-900/50"
                        />
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPurgeConfirmOpen(false)} disabled={isPurging}>Cancel</Button>
                        <Button 
                            variant="destructive" 
                            onClick={handlePurgeInactive} 
                            disabled={isPurging || purgeInput !== "PURGE ALL"}
                        >
                            {isPurging ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
                            Confirm Purge
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    )
}