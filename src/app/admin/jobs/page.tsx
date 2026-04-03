"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { 
    ArrowLeft, Calendar, Loader2, Play, Save, Database, ShieldAlert, 
    Activity, RefreshCw, FileText, ExternalLink, Download, 
    UploadCloud, TrendingUp, FileArchive, FileJson, Mail
} from "lucide-react"
import { getErrorMessage } from "@/lib/utils/error"

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
  const [embedMetadataSchedule, setEmbedMetadataSchedule] = useState("0") 
  const [librarySyncSchedule, setLibrarySyncSchedule] = useState("12") 
  const [monitorSyncSchedule, setMonitorSyncSchedule] = useState("24") 
  const [diagnosticsSyncSchedule, setDiagnosticsSyncSchedule] = useState("168")
  const [backupSyncSchedule, setBackupSyncSchedule] = useState("168") 
  const [popularSyncSchedule, setPopularSyncSchedule] = useState("24")
  const [converterSyncSchedule, setConverterSyncSchedule] = useState("24")
  const [weeklyDigestSchedule, setWeeklyDigestSchedule] = useState("168") // <-- Weekly Digest Schedule
  
  const [savingJobs, setSavingJobs] = useState(false)
  const [runningJob, setRunningJob] = useState<string | null>(null) 
  const [loading, setLoading] = useState(true)
  
  const [isRestoring, setIsRestoring] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { toast } = useToast()

  useEffect(() => {
    document.title = "Omnibus - Scheduled Jobs"
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/admin/config');
      if (res.ok) {
        const data = await res.json();
        const metaItem = data.settings.find((c: any) => c.key === 'metadata_sync_schedule');
        const embedItem = data.settings.find((c: any) => c.key === 'embed_metadata_schedule'); 
        const libItem = data.settings.find((c: any) => c.key === 'library_sync_schedule');
        const monitorItem = data.settings.find((c: any) => c.key === 'monitor_sync_schedule'); 
        const diagItem = data.settings.find((c: any) => c.key === 'diagnostics_sync_schedule'); 
        const backupItem = data.settings.find((c: any) => c.key === 'backup_sync_schedule'); 
        const popularItem = data.settings.find((c: any) => c.key === 'popular_sync_schedule'); 
        const converterItem = data.settings.find((c: any) => c.key === 'cbr_conversion_schedule');
        const digestItem = data.settings.find((c: any) => c.key === 'weekly_digest_schedule'); // <-- Fetch Digest config
        
        if (metaItem) setMetadataSyncSchedule(metaItem.value);
        if (embedItem) setEmbedMetadataSchedule(embedItem.value);
        if (libItem) setLibrarySyncSchedule(libItem.value);
        if (monitorItem) setMonitorSyncSchedule(monitorItem.value);
        if (diagItem) setDiagnosticsSyncSchedule(diagItem.value);
        if (backupItem) setBackupSyncSchedule(backupItem.value);
        if (popularItem) setPopularSyncSchedule(popularItem.value); 
        if (converterItem) setConverterSyncSchedule(converterItem.value);
        if (digestItem) setWeeklyDigestSchedule(digestItem.value);
      }
    } catch (e) {
      toast({ title: "Error", description: "Failed to load schedules.", variant: "destructive" });
    } finally {
      setLoading(false)
    }
  };

  const handleRunJob = async (job: 'metadata' | 'library' | 'monitor' | 'diagnostics' | 'backup' | 'popular' | 'converter' | 'embed_metadata' | 'weekly_digest') => {
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
                  settings: {
                      metadata_sync_schedule: metadataSyncSchedule,
                      embed_metadata_schedule: embedMetadataSchedule,
                      library_sync_schedule: librarySyncSchedule,
                      monitor_sync_schedule: monitorSyncSchedule,
                      diagnostics_sync_schedule: diagnosticsSyncSchedule,
                      backup_sync_schedule: backupSyncSchedule,
                      popular_sync_schedule: popularSyncSchedule,
                      cbr_conversion_schedule: converterSyncSchedule,
                      weekly_digest_schedule: weeklyDigestSchedule // <-- Save Digest config
                  }
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
      } catch (error: unknown) {
          toast({ title: "Restore Failed", description: getErrorMessage(error), variant: "destructive" });
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        
        {/* DATABASE BACKUP */}
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
                    <input type="file" accept=".json" ref={fileInputRef} className="hidden" onChange={handleRestoreUpload} />
                    <Button variant="outline" className="w-full font-bold border-primary/30 text-primary hover:bg-primary/10" disabled={isRestoring} onClick={() => fileInputRef.current?.click()}>
                        {isRestoring ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <UploadCloud className="w-4 h-4 mr-2"/>} 
                        {isRestoring ? "Restoring..." : "Restore from JSON"}
                    </Button>
                </div>
            </CardContent>
        </Card>

        {/* LIBRARY AUTO-SCAN */}
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

        {/* DEEP METADATA SYNC */}
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

        {/* EMBED XML METADATA */}
        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><FileJson className="w-5 h-5 text-primary" /> Embed XML Metadata</CardTitle>
                <CardDescription className="text-muted-foreground">Writes ComicInfo.xml data directly into your downloaded .cbz archives.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={embedMetadataSchedule} onValueChange={setEmbedMetadataSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('embed_metadata')} disabled={runningJob === 'embed_metadata'}>
                    {runningJob === 'embed_metadata' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>

        {/* NEW ISSUE MONITOR */}
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

        {/* CBR AUTO-CONVERTER */}
        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><FileArchive className="w-5 h-5 text-primary" /> CBR Auto-Converter</CardTitle>
                <CardDescription className="text-muted-foreground">Finds legacy .cbr archives in your library and converts them to .cbz for instant loading.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={converterSyncSchedule} onValueChange={setConverterSyncSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('converter')} disabled={runningJob === 'converter'}>
                    {runningJob === 'converter' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
                </Button>
            </CardContent>
        </Card>

        {/* DISCOVER SYNC */}
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

        {/* SYSTEM DIAGNOSTICS */}
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

        {/* --- WEEKLY DIGEST EMAIL --- */}
        <Card className="shadow-sm border-border bg-background transition-all hover:shadow-md">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg text-foreground"><Mail className="w-5 h-5 text-primary" /> Weekly Email Digest</CardTitle>
                <CardDescription className="text-muted-foreground">Sends users an email of newly added library items over the past 7 days (SMTP required).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Select value={weeklyDigestSchedule} onValueChange={setWeeklyDigestSchedule}>
                    <SelectTrigger className="bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        {INTERVALS.map(i => <SelectItem key={i.value} value={i.value} className="focus:bg-primary/10 focus:text-primary">{i.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Button className="w-full font-bold border-border hover:bg-muted" variant="outline" onClick={() => handleRunJob('weekly_digest')} disabled={runningJob === 'weekly_digest'}>
                    {runningJob === 'weekly_digest' ? <Loader2 className="w-4 h-4 mr-2 animate-spin"/> : <Play className="w-4 h-4 mr-2"/>} Run Now
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