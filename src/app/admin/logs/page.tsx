"use client"

import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { 
    ArrowLeft, Trash2, Terminal, History, Loader2, Download, Eye, 
    Clock, AlertTriangle, CheckCircle2, ShieldAlert, Database, 
    RefreshCw, Activity, Search, CalendarMinus 
} from "lucide-react"
import Link from "next/link"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"

export default function LogsPage() {
  const { toast } = useToast();

  // Live Terminal State
  const [liveLogs, setLiveLogs] = useState<any[]>([])
  
  // Job History State
  const [jobLogs, setJobLogs] = useState<any[]>([])
  const [loadingJobs, setLoadingJobs] = useState(true)
  const [statusFilter, setStatusFilter] = useState("ALL")
  const [typeFilter, setTypeFilter] = useState("ALL")
  const [selectedLogDetails, setSelectedLogDetails] = useState<any>(null)

  // Confirmation States
  const [clearLiveConfirmOpen, setClearLiveConfirmOpen] = useState(false) 
  const [clearHistoryConfirmOpen, setClearHistoryConfirmOpen] = useState(false) 
  const [purgeOldConfirmOpen, setPurgeOldConfirmOpen] = useState(false) 
  const [isClearing, setIsClearing] = useState(false) 

  useEffect(() => {
    document.title = "Omnibus - System Logs";
    fetchLiveLogs();
    fetchJobLogs();
    const interval = setInterval(fetchLiveLogs, 3000);
    return () => clearInterval(interval);
  }, [])

  const fetchLiveLogs = async () => {
    try {
        const res = await fetch('/api/admin/logs')
        if (res.ok) setLiveLogs(await res.json())
    } catch (e) {}
  }

  const fetchJobLogs = async () => {
    setLoadingJobs(true);
    try {
        const res = await fetch('/api/admin/job-logs')
        if (res.ok) setJobLogs(await res.json())
    } catch (e) {} finally {
        setLoadingJobs(false);
    }
  }

  const handleClearLive = async () => {
    setIsClearing(true);
    try {
      await fetch('/api/admin/logs', { method: 'DELETE' });
      await fetchLiveLogs();
      setClearLiveConfirmOpen(false);
      toast({ title: "Terminal Cleared" });
    } finally { setIsClearing(false); }
  }

  const handleClearHistory = async () => {
    setIsClearing(true);
    try {
      await fetch('/api/admin/job-logs', { method: 'DELETE' });
      await fetchJobLogs();
      setClearHistoryConfirmOpen(false);
      toast({ title: "History Deleted", description: "All database job logs have been removed." });
    } finally { setIsClearing(false); }
  }

  const handlePurgeOld = async () => {
    setIsClearing(true);
    try {
      await fetch('/api/admin/job-logs?days=7', { method: 'DELETE' });
      await fetchJobLogs();
      setPurgeOldConfirmOpen(false);
      toast({ title: "Logs Purged", description: "Logs older than 7 days have been deleted." });
    } finally { setIsClearing(false); }
  }

  const formatDuration = (ms: number | null) => {
      if (!ms) return '-';
      if (ms < 1000) return `${ms} ms`;
      if (ms < 60000) return `${(ms/1000).toFixed(1)} s`;
      return `${(ms/60000).toFixed(1)} m`;
  }

  const formatJobType = (type: string) => {
      return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  const getJobIcon = (type: string) => {
      switch(type) {
          case 'DIAGNOSTICS': return <ShieldAlert className="w-4 h-4 text-red-500" />;
          case 'LIBRARY_SCAN': return <Database className="w-4 h-4 text-primary" />;
          case 'METADATA_SYNC': return <RefreshCw className="w-4 h-4 text-green-500" />;
          case 'SERIES_MONITOR': return <Activity className="w-4 h-4 text-orange-500" />;
          case 'DOWNLOAD_RETRY': return <Clock className="w-4 h-4 text-primary" />;
          default: return <History className="w-4 h-4 text-muted-foreground" />;
      }
  }

  const downloadLog = (log: any) => {
      const header = `Omnibus Log Report\nType: ${formatJobType(log.jobType)}\nStatus: ${log.status}\nDate: ${new Date(log.createdAt).toLocaleString()}\nDuration: ${formatDuration(log.durationMs)}\nRelated Item: ${log.relatedItem || 'N/A'}\n\n--- DETAILS ---\n\n`;
      const blob = new Blob([header + (log.message || "No detailed output provided.")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `omnibus-${log.jobType}-${new Date(log.createdAt).getTime()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
  }

  const filteredJobs = useMemo(() => {
      return jobLogs.filter(log => {
          if (statusFilter !== "ALL" && log.status !== statusFilter) return false;
          if (typeFilter !== "ALL" && log.jobType !== typeFilter) return false;
          return true;
      });
  }, [jobLogs, statusFilter, typeFilter]);

  const uniqueJobTypes = useMemo(() => Array.from(new Set(jobLogs.map(l => l.jobType))), [jobLogs]);

  return (
    <div className="container mx-auto py-10 px-6 max-w-6xl space-y-6 transition-colors duration-300">
      
      <div className="flex items-center gap-4">
        <Link href="/admin"><Button variant="ghost" size="icon" className="hover:bg-muted text-foreground"><ArrowLeft /></Button></Link>
        <h1 className="text-3xl font-bold text-foreground">System Logs</h1>
      </div>

      <Tabs defaultValue="live" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2 bg-muted border border-border p-1">
            <TabsTrigger value="live" className="flex gap-2 data-[state=active]:bg-background data-[state=active]:text-primary"><Terminal className="w-4 h-4"/> Live Terminal</TabsTrigger>
            <TabsTrigger value="history" className="flex gap-2 data-[state=active]:bg-background data-[state=active]:text-primary" onClick={fetchJobLogs}><History className="w-4 h-4"/> Job History</TabsTrigger>
        </TabsList>

        {/* --- LIVE TERMINAL TAB --- */}
        <TabsContent value="live" className="space-y-4 mt-6 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex justify-between items-end">
                <p className="text-sm text-muted-foreground">Real-time output from the backend server.</p>
                <Button variant="outline" size="sm" onClick={() => setClearLiveConfirmOpen(true)} className="border-border hover:bg-muted font-bold">
                    <Trash2 className="w-4 h-4 mr-2" /> Clear Terminal
                </Button>
            </div>
            {/* UPDATED TERMINAL CONTAINER: Using dynamic bg-muted and border-primary/20 */}
            <Card className="bg-muted border-primary/20 shadow-2xl overflow-hidden transition-colors duration-300">
                <CardHeader className="border-b border-primary/10 pb-4 bg-background/50">
                    <CardTitle className="text-primary text-sm flex items-center gap-2">
                        <Terminal className="w-4 h-4" /> Live Terminal Output
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="h-[600px] overflow-y-auto p-4 font-mono text-xs space-y-1 scrollbar-thin scrollbar-thumb-primary/20">
                        {liveLogs.length === 0 && <p className="text-muted-foreground italic">Waiting for system activity...</p>}
                        {liveLogs.map((log, i) => (
                        <div key={i} className="flex gap-3 border-b border-primary/5 py-1 transition-colors hover:bg-primary/5">
                            <span className="text-muted-foreground shrink-0">[{log.timestamp}]</span>
                            <span className={
                                log.type === 'error' ? 'text-red-500 font-bold' : 
                                log.type === 'success' ? 'text-green-600 dark:text-green-400 font-bold' : 
                                log.type === 'warn' ? 'text-orange-500' : 
                                'text-foreground'
                            }>
                                {log.message}
                            </span>
                        </div>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </TabsContent>

        {/* --- STORED JOB HISTORY TAB --- */}
        <TabsContent value="history" className="space-y-4 mt-6 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-muted/50 p-4 rounded-lg border border-border">
                <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
                    <Select value={typeFilter} onValueChange={setTypeFilter}>
                        <SelectTrigger className="w-full sm:w-[200px] bg-background border-border text-foreground h-10">
                            <SelectValue placeholder="All Job Types" />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border">
                            <SelectItem value="ALL" className="focus:bg-primary/10 focus:text-primary">All Job Types</SelectItem>
                            {uniqueJobTypes.map(t => <SelectItem key={t} value={t} className="focus:bg-primary/10 focus:text-primary">{formatJobType(t)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-full sm:w-[180px] bg-background border-border text-foreground h-10">
                            <SelectValue placeholder="All Statuses" />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border">
                            <SelectItem value="ALL" className="focus:bg-primary/10 focus:text-primary">All Statuses</SelectItem>
                            <SelectItem value="COMPLETED" className="focus:bg-primary/10 focus:text-primary">Completed</SelectItem>
                            <SelectItem value="COMPLETED_WITH_ERRORS" className="focus:bg-primary/10 focus:text-primary">Completed (Errors)</SelectItem>
                            <SelectItem value="FAILED" className="focus:bg-primary/10 focus:text-primary">Failed</SelectItem>
                            <SelectItem value="IN_PROGRESS" className="focus:bg-primary/10 focus:text-primary">In Progress</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" onClick={fetchJobLogs} className="text-primary hover:bg-primary/10 font-bold">
                        <RefreshCw className={`w-4 h-4 mr-1 ${loadingJobs ? 'animate-spin' : ''}`} /> Refresh
                    </Button>
                </div>
                
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPurgeOldConfirmOpen(true)} className="border-border hover:bg-muted text-orange-500 hover:text-orange-600 shrink-0 font-bold h-10">
                        <CalendarMinus className="w-4 h-4 mr-2" /> Purge &gt; 7 Days
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setClearHistoryConfirmOpen(true)} className="border-border hover:bg-muted text-red-500 hover:text-red-600 shrink-0 font-bold h-10">
                        <Trash2 className="w-4 h-4 mr-2" /> Delete All
                    </Button>
                </div>
            </div>

            <div className="border border-border rounded-lg overflow-hidden bg-background shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
                            <tr>
                                <th className="px-4 py-3">Date & Time</th>
                                <th className="px-4 py-3">Job Type</th>
                                <th className="px-4 py-3 text-center">Status</th>
                                <th className="px-4 py-3">Related Item</th>
                                <th className="px-4 py-3 text-center">Duration</th>
                                <th className="px-4 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {loadingJobs ? (
                                <tr><td colSpan={6} className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></td></tr>
                            ) : filteredJobs.length === 0 ? (
                                <tr><td colSpan={6} className="text-center py-10 text-muted-foreground italic">No historical job logs found.</td></tr>
                            ) : (
                                filteredJobs.map((log) => (
                                    <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                                        <td className="px-4 py-3 font-medium whitespace-nowrap text-xs text-muted-foreground">
                                            {new Date(log.createdAt).toLocaleString()}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2 font-semibold text-foreground">
                                                {getJobIcon(log.jobType)}
                                                {formatJobType(log.jobType)}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            {log.status === 'COMPLETED' && <Badge variant="outline" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-none px-2 py-0.5"><CheckCircle2 className="w-3 h-3 mr-1"/> Success</Badge>}
                                            {log.status === 'FAILED' && <Badge variant="outline" className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-none px-2 py-0.5"><AlertTriangle className="w-3 h-3 mr-1"/> Failed</Badge>}
                                            {log.status === 'COMPLETED_WITH_ERRORS' && <Badge variant="outline" className="bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-none px-2 py-0.5"><AlertTriangle className="w-3 h-3 mr-1"/> Warnings</Badge>}
                                            {log.status === 'IN_PROGRESS' && <Badge variant="outline" className="bg-primary/10 text-primary border-none px-2 py-0.5"><Loader2 className="w-3 h-3 mr-1 animate-spin"/> Active</Badge>}
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground truncate max-w-[200px]" title={log.relatedItem || ''}>
                                            {log.relatedItem || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-center font-mono text-xs text-muted-foreground">
                                            {formatDuration(log.durationMs)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center justify-end gap-1">
                                                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary hover:bg-primary/10" onClick={() => setSelectedLogDetails(log)} title="View Details">
                                                    <Eye className="w-4 h-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-8 w-8 text-foreground hover:bg-muted" onClick={() => downloadLog(log)} title="Download Output">
                                                    <Download className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </TabsContent>
      </Tabs>

      {/* Details Modal */}
      <Dialog open={!!selectedLogDetails} onOpenChange={() => setSelectedLogDetails(null)}>
        <DialogContent className="sm:max-w-3xl bg-background border-border rounded-xl">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-foreground">
                    {selectedLogDetails && getJobIcon(selectedLogDetails.jobType)}
                    {selectedLogDetails ? formatJobType(selectedLogDetails.jobType) : 'Log Details'}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                    Executed on {selectedLogDetails ? new Date(selectedLogDetails.createdAt).toLocaleString() : ''}
                </DialogDescription>
            </DialogHeader>
            
            {selectedLogDetails && (
                <div className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm bg-muted/50 p-4 rounded-md border border-border">
                        <div className="flex flex-col"><span className="text-[10px] text-muted-foreground uppercase font-black">Status</span><span className="font-semibold text-foreground">{selectedLogDetails.status.replace(/_/g, ' ')}</span></div>
                        <div className="flex flex-col"><span className="text-[10px] text-muted-foreground uppercase font-black">Target</span><span className="font-semibold truncate text-foreground">{selectedLogDetails.relatedItem || 'Global'}</span></div>
                        <div className="flex flex-col"><span className="text-[10px] text-muted-foreground uppercase font-black">Duration</span><span className="font-mono text-foreground">{formatDuration(selectedLogDetails.durationMs)}</span></div>
                        <div className="flex flex-col"><span className="text-[10px] text-muted-foreground uppercase font-black">Trigger</span><span className="font-semibold text-foreground">{selectedLogDetails.durationMs > 0 ? 'Automatic/UI' : 'Heartbeat'}</span></div>
                    </div>
                    
                    <div className="space-y-2">
                        <Label className="uppercase text-[10px] font-black text-muted-foreground">Detailed Output Trace</Label>
                        <div className="bg-slate-950 rounded-md p-4 max-h-[400px] overflow-y-auto border border-white/10 shadow-inner">
                            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                                {selectedLogDetails.message || "No detailed output provided for this job."}
                            </pre>
                        </div>
                    </div>
                </div>
            )}
            <DialogFooter className="gap-2">
                <Button variant="outline" className="border-border hover:bg-muted font-bold" onClick={() => downloadLog(selectedLogDetails)}>
                    <Download className="w-4 h-4 mr-2" /> Download TXT
                </Button>
                <Button className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold" onClick={() => setSelectedLogDetails(null)}>Close Details</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialogs */}
      <ConfirmationDialog 
        isOpen={purgeOldConfirmOpen}
        onClose={() => setPurgeOldConfirmOpen(false)}
        onConfirm={handlePurgeOld}
        isLoading={isClearing}
        title="Purge Old Logs?"
        description="This will permanently delete all historical job logs older than 7 days. This helps keep your database lean and performant."
        confirmText="Purge Logs"
      />

      <ConfirmationDialog 
        isOpen={clearLiveConfirmOpen}
        onClose={() => setClearLiveConfirmOpen(false)}
        onConfirm={handleClearLive}
        isLoading={isClearing}
        title="Clear Live Terminal?"
        description="Are you sure you want to permanently delete all real-time terminal output? This cannot be undone."
        confirmText="Clear Terminal"
      />

      <ConfirmationDialog 
        isOpen={clearHistoryConfirmOpen}
        onClose={() => setClearHistoryConfirmOpen(false)}
        onConfirm={handleClearHistory}
        isLoading={isClearing}
        title="Delete ALL Job History?"
        description="This will wipe ALL historical records of past automated jobs and downloads. This action cannot be undone."
        confirmText="Delete All History"
      />
    </div>
  )
}