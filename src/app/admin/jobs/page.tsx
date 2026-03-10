"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { 
    ArrowLeft, Calendar, Loader2, Play, Save, Database, ShieldAlert, 
    Activity, RefreshCw, Clock, FileText, ExternalLink, Download, 
    UploadCloud, TrendingUp 
} from "lucide-react"

const INTERVALS = [
    { label: "Disabled (Manual Only)", value: "0" },
    { label: "Every Hour", value: "1" },
    { label: "Every 6 Hours", value: "6" },
    { label: "Every 12 Hours", value: "12" },
    { label: "Every 24 Hours", value: "24" },
    { label: "Every 48 Hours", value: "48" },
    { label: "Weekly", value: "168" }
];

export default function ScheduledJobsPage() {
  const [metadataSyncSchedule, setMetadataSyncSchedule] = useState("24")
  const [librarySyncSchedule, setLibrarySyncSchedule] = useState("12") 
  const [monitorSyncSchedule, setMonitorSyncSchedule] = useState("24") 
  const [diagnosticsSyncSchedule, setDiagnosticsSyncSchedule] = useState("168")
  const [backupSyncSchedule, setBackupSyncSchedule] = useState("168") 
  
  // NEW: State for Popular/New Release Sync
  const [popularSyncSchedule, setPopularSyncSchedule] = useState("24")
  
  const [savingJobs, setSavingJobs] = useState(false)
  const [runningJob, setRunningJob] = useState<string | null>(null) 
  const [loading, setLoading] = useState(true)
  
  // Restore State
  const [isRestoring, setIsRestoring] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { toast } = useToast()

  useEffect(() => {
    document.title = "Omnibus - Scheduled Tasks"
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/admin/config');
      if (res.ok) {
        const data = await res.json();
        const metaItem = data.find((c: any) => c.key === 'metadata_sync_schedule');
        const libItem = data.find((c: any) => c.key === 'library_sync_schedule');
        const monitorItem = data.find((c: any) => c.key === 'monitor_sync_schedule'); 
        const diagItem = data.find((c: any) => c.key === 'diagnostics_sync_schedule'); 
        const backupItem = data.find((c: any) => c.key === 'backup_sync_schedule'); 
        const popularItem = data.find((c: any) => c.key === 'popular_sync_schedule'); // NEW
        
        if (metaItem) setMetadataSyncSchedule(metaItem.value);
        if (libItem) setLibrarySyncSchedule(libItem.value);
        if (monitorItem) setMonitorSyncSchedule(monitorItem.value);
        if (diagItem) setDiagnosticsSyncSchedule(diagItem.value);
        if (backupItem) setBackupSyncSchedule(backupItem.value);
        if (popularItem) setPopularSyncSchedule(popularItem.value); // NEW
      }
    } catch (e) {
      toast({ title: "Error", description: "Failed to load schedules.", variant: "destructive" });
    } finally {
      setLoading(false)
    }
  };

  const handleRunJob = async (job: 'metadata' | 'library' | 'monitor' | 'diagnostics' | 'backup' | 'popular') => {
      setRunningJob(job);
      toast({ title: "Job Started", description: `The ${job} process has been triggered in the background.` });
      try {
          const res = await fetch('/api/admin/jobs/trigger', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ job })
          });
          const data = await res.json();
          if (res.ok) {
              toast({ title: "Update Sent", description: data.message });
          } else {
              throw new Error(data.error || "Job failed to start.");
          }
      } catch (e: any) {
          toast({ title: "Error", description: e.message, variant: "destructive" });
      } finally {
          setRunningJob(null);
      }
  }

  const saveScheduledJobs = async () => {
      setSavingJobs(true)
      try {
          const res = await fetch('/api/admin/config', { 
              method: 'POST', 
              headers: { 'Content-Type': 'application/json' }, 
              body: JSON.stringify({ 
                  metadata_sync_schedule: metadataSyncSchedule,
                  library_sync_schedule: librarySyncSchedule,
                  monitor_sync_schedule: monitorSyncSchedule,
                  diagnostics_sync_schedule: diagnosticsSyncSchedule,
                  backup_sync_schedule: backupSyncSchedule,
                  popular_sync_schedule: popularSyncSchedule // NEW
              }) 
          })
          if (res.ok) {
              toast({ title: "Jobs Updated", description: "The background schedules have been successfully saved." })
          } else {
              throw new Error("Failed to save config")
          }
      } catch (e) {
          toast({ title: "Error", description: "Could not save jobs schedule.", variant: "destructive" })
      } finally {
          setSavingJobs(false)
      }
  }

  // --- RESTORE HANDLER ---
  const handleRestoreUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsRestoring(true);
      toast({ title: "Restoring Database", description: "Merging backup file. Do not close this window..." });

      const formData = new FormData();
      formData.append('file', file);

      try {
          const res = await fetch('/api/admin/restore', {
              method: 'POST',
              body: formData
          });

          const data = await res.json();

          if (res.ok) {
              toast({ title: "Restore Complete", description: "Your library and progress data has been successfully merged!" });
              setTimeout(() => window.location.reload(), 1500); 
          } else {
              throw new Error(data.error || "Failed to restore");
          }
      } catch (error: any) {
          toast({ title: "Restore Failed", description: error.message, variant: "destructive" });
      } finally {
          setIsRestoring(false);
          if (fileInputRef.current) fileInputRef.current.value = ''; 
      }
  }

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>

  return (
    <div className="container mx-auto py-10 px-6 max-w-6xl space-y-8 transition-colors duration-300">
      <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
        <div className="flex items-center gap-4">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="hover:bg-muted text-foreground">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">
              <Calendar className="w-7 h-7 text-primary" /> Scheduled Jobs
            </h1>
        </div>
        <div className="flex items-center gap-3">
            <Button variant="outline" asChild className="border-border hover:bg-muted text-foreground">
                <Link href="/admin/logs" className="flex items-center gap-2">
                    <FileText className="w-4 h-4" /> View Logs
                </Link>
            </Button>
            <Button onClick={saveScheduledJobs} disabled={savingJobs || loading} className="shadow-md bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                {savingJobs ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                Save Schedule
            </Button>
        </div>
      </div>

      <div className="bg-primary/10 border border-primary/20 rounded-xl p-6 mb-10 transition-colors">
          <h2 className="text-lg font-bold text-primary flex items-center gap-2 mb-2">
              <Clock className="w-5 h-5" /> Automating Your Schedules
          </h2>
          <p className="text-sm text-foreground/80 leading-relaxed">
              Omnibus evaluates schedules dynamically based on your intervals below. To run them completely automatically, set up a server CRON job or an uptime monitor (like UptimeKuma) to ping the heartbeat URL every 15 minutes:
          </p>
          <code className="block mt-3 bg-background p-3 rounded border border-border text-primary font-mono font-bold select-all shadow-sm">
              {typeof window !== 'undefined' ? `${window.location.origin}/api/cron` : '/api/cron'}
          </code>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* DATABASE BACKUP & RESTORE CARD */}
        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><Save className="w-5 h-5 text-primary" /> Database Backup</CardTitle>
                <CardDescription className="text-muted-foreground">Exports or restores library and user data to a JSON file.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={backupSyncSchedule} onValueChange={setBackupSyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                
                <div className="grid grid-cols-2 gap-2">
                    <Button className="w-full font-bold shadow-sm text-[11px] border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('backup')} disabled={runningJob === 'backup'}>
                        {runningJob === 'backup' ? <Loader2 className="w-3 h-3 mr-2 animate-spin"/> : <Play className="w-3 h-3 mr-2"/>} Auto-Save
                    </Button>
                    <Button className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm text-[11px] border-0" asChild>
                        <a href="/api/admin/backup" download><Download className="w-3 h-3 mr-2"/> Download</a>
                    </Button>
                </div>
                
                <div className="pt-2 border-t border-border">
                    <input 
                        type="file" 
                        accept=".json" 
                        ref={fileInputRef} 
                        className="hidden" 
                        onChange={handleRestoreUpload} 
                    />
                    <Button 
                        variant="outline" 
                        className="w-full font-bold border-primary/30 text-primary hover:bg-primary/10"
                        disabled={isRestoring}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        {isRestoring ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <UploadCloud className="w-4 h-4 mr-2"/>} 
                        {isRestoring ? "Restoring..." : "Restore from JSON"}
                    </Button>
                </div>

            </CardContent>
        </Card>

        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><Database className="w-5 h-5 text-primary" /> Library Auto-Scan</CardTitle>
                <CardDescription className="text-muted-foreground">Scans disk for newly dropped files and indexes them.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={librarySyncSchedule} onValueChange={setLibrarySyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('library')} disabled={runningJob === 'library'}>
                    {runningJob === 'library' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>

        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><RefreshCw className="w-5 h-5 text-primary" /> Deep Metadata Sync</CardTitle>
                <CardDescription className="text-muted-foreground">Re-syncs series with ComicVine to update covers and info.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={metadataSyncSchedule} onValueChange={setMetadataSyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('metadata')} disabled={runningJob === 'metadata'}>
                    {runningJob === 'metadata' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>

        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><Activity className="w-5 h-5 text-primary" /> New Issue Monitor</CardTitle>
                <CardDescription className="text-muted-foreground">Checks monitored series for new weekly ComicVine releases.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={monitorSyncSchedule} onValueChange={setMonitorSyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('monitor')} disabled={runningJob === 'monitor'}>
                    {runningJob === 'monitor' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>

        {/* NEW DISCOVER / POPULAR SYNC CARD */}
        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><TrendingUp className="w-5 h-5 text-primary" /> Discover Sync</CardTitle>
                <CardDescription className="text-muted-foreground">Refreshes homepage new releases and popular issues.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={popularSyncSchedule} onValueChange={setPopularSyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('popular')} disabled={runningJob === 'popular'}>
                    {runningJob === 'popular' ? <Loader2 className="w-4 h-4 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>

        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><ShieldAlert className="w-5 h-5 text-primary" /> System Diagnostics</CardTitle>
                <CardDescription className="text-muted-foreground">Tests library integrity and checks for corrupted archives.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={diagnosticsSyncSchedule} onValueChange={setDiagnosticsSyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('diagnostics')} disabled={runningJob === 'diagnostics'}>
                    {runningJob === 'diagnostics' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>
      </div>

      <div className="pt-8">
        <Card className="border-dashed border-2 bg-muted/20 border-border">
            <CardContent className="p-8 flex flex-col items-center text-center space-y-3">
                <div className="p-3 bg-background rounded-full shadow-sm border border-border">
                    <FileText className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="font-bold text-lg text-foreground">Job History & Debugging</h3>
                <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
                    Automated job results and detailed background logs are centralized on the System Logs page. 
                    Visit the logs to view success rates or debug failed tasks.
                </p>
                <Button variant="outline" asChild className="mt-2 border-border hover:bg-muted text-foreground bg-background">
                    <Link href="/admin/logs" className="flex items-center gap-2">
                        View System Logs <ExternalLink className="w-3 h-3" />
                    </Link>
                </Button>
            </CardContent>
        </Card>
      </div>
    </div>
  )
}