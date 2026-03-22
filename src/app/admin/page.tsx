"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { 
  TrendingUp, Download, HardDrive, ArrowRight, Loader2, RefreshCw, 
  AlertTriangle, Users, CheckCircle2, Activity, XCircle, 
  Settings, Trophy, Calendar, FileText, ExternalLink, Clock, Trash2,
  ThumbsUp, ThumbsDown, ImageIcon, EyeOff, Sparkles, ShieldAlert, BarChart3,
  Check
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { AdminRequestManagement } from "@/components/admin-request-management"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { getErrorMessage } from "@/lib/utils/error"

// Skeleton for individual Stat Cards
function StatSkeleton() {
  return (
    <Card className="shadow-sm border-border bg-background">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="h-4 w-24 bg-muted animate-pulse rounded" />
        <div className="h-4 w-4 bg-muted animate-pulse rounded" />
      </CardHeader>
      <CardContent>
        <div className="h-8 w-16 bg-muted animate-pulse rounded mb-2" />
        <div className="h-3 w-32 bg-muted animate-pulse rounded" />
      </CardContent>
    </Card>
  );
}

// Skeleton for the Download Queue items
function QueueSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="flex flex-col md:flex-row items-start md:items-center justify-between p-4 bg-background border border-border rounded-lg shadow-sm gap-4">
          <div className="w-10 h-14 bg-muted animate-pulse rounded shrink-0 border border-border" />
          <div className="flex-1 space-y-2 w-full">
            <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
            <div className="h-3 w-1/2 bg-muted animate-pulse rounded" />
          </div>
          <div className="w-full md:w-48 space-y-2">
            <div className="h-2 w-full bg-muted animate-pulse rounded" />
            <div className="h-3 w-8 ml-auto bg-muted animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminPage() {
  if (typeof document !== 'undefined') {
    document.title = "Omnibus - Admin";
  }

  const [torrents, setTorrents] = useState<any[]>([])
  const [requests, setRequests] = useState<any[]>([])
  
  const [stats, setStats] = useState({ 
    totalRequests: 0, 
    completed30d: 0, 
    failed30d: 0, 
    totalUsers: 0,
    healthStatus: "HEALTHY",
    failureRate: 0 
  })
  
  const [statsLoading, setStatsLoading] = useState(true)
  const [reqsLoading, setReqsLoading] = useState(true)
  const [downloadsLoading, setDownloadsLoading] = useState(true)

  const [updateData, setUpdateData] = useState<any>(null)

  const [importing, setImporting] = useState<string | null>(null)
  const [ignoringId, setIgnoringId] = useState<string | null>(null) 
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [systemHealthy, setSystemHealthy] = useState(true)

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [requestToDelete, setRequestToDelete] = useState<{id: string, name: string} | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const [selectedRequests, setSelectedRequests] = useState<Set<string>>(new Set())
  const [isBulkProcessing, setIsBulkProcessing] = useState(false)
  
  const { toast } = useToast()

  useEffect(() => {
    document.title = "Omnibus - Admin"
  }, [statsLoading, reqsLoading, downloadsLoading]);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/admin/stats');
      const data = await res.json();
      if (res.ok && data.success) {
        setStats({ 
          totalRequests: data.totalRequests, 
          completed30d: data.completed30d, 
          failed30d: data.failed30d, 
          totalUsers: data.totalUsers,
          healthStatus: data.healthStatus || "HEALTHY",
          failureRate: data.failureRate || 0
        });
      }
    } finally { setStatsLoading(false); }
  };

  const fetchRequests = async () => {
    try {
      const res = await fetch('/api/admin/requests?activeOnly=true'); 
      if (res.ok) setRequests(await res.json());
    } finally { setReqsLoading(false); }
  };

  const fetchDownloads = async () => {
    try {
      const res = await fetch('/api/admin/active-downloads');
      const data = await res.json();
      if (res.ok && data.success) {
        setTorrents(data.activeDownloads || []);
        setErrorMessage(null);
        setSystemHealthy(true);
      } else {
        setErrorMessage(data.error);
        setSystemHealthy(false);
      }
    } catch (e) {
      setErrorMessage("System communication error.");
      setSystemHealthy(false);
    } finally { setDownloadsLoading(false); }
  };

  const fetchUpdates = () => {
      fetch('/api/admin/update-check').then(res => res.json()).then(setUpdateData).catch(() => {});
  };

  const fetchAll = () => {
      fetchStats();
      fetchRequests();
      fetchDownloads();
      fetchUpdates();
  };

  // --- FIX 6b: Extract intervals into proper constants ---
  const ADMIN_DASHBOARD_POLL_INTERVAL_MS = 15 * 1000; // 15 seconds
  const ADMIN_ALERT_POLL_INTERVAL_MS = 300 * 1000; // 5 minutes

  useEffect(() => {
    fetchAll();
    
    // Poll internal database and download clients every 15s
    const dashboardInterval = setInterval(() => {
        fetchStats();
        fetchRequests();
        fetchDownloads();
    }, ADMIN_DASHBOARD_POLL_INTERVAL_MS);

    // Poll external GitHub API for updates every 5m to avoid rate limits
    const alertInterval = setInterval(() => {
        fetchUpdates();
    }, ADMIN_ALERT_POLL_INTERVAL_MS);

    return () => {
        clearInterval(dashboardInterval);
        clearInterval(alertInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleApprovalAction = async (id: string, status: 'PENDING' | 'CANCELLED') => {
    try {
      const res = await fetch('/api/request', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) });
      if (res.ok) {
        toast({ title: status === 'PENDING' ? "Request Approved" : "Request Denied" });
        fetchRequests(); 
        setSelectedRequests(prev => { const n = new Set(prev); n.delete(id); return n; });
      }
    } catch (e) { toast({ title: "Error", variant: "destructive" }); }
  };

  const toggleSelection = (id: string) => {
    setSelectedRequests(prev => {
        const newSet = new Set(prev);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        return newSet;
    });
  };

  const handleBulkApprovalAction = async (status: 'PENDING' | 'CANCELLED') => {
      if (selectedRequests.size === 0) return;
      setIsBulkProcessing(true);
      try {
          const promises = Array.from(selectedRequests).map(id => 
              fetch('/api/request', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) })
          );
          await Promise.all(promises);
          toast({ 
              title: status === 'PENDING' ? "Bulk Approval Complete" : "Bulk Denial Complete", 
              description: `Successfully processed ${selectedRequests.size} requests.` 
          });
          setSelectedRequests(new Set()); 
          fetchRequests();
      } catch(e) {
          toast({ title: "Error", description: "Failed to process some requests", variant: "destructive" });
      } finally {
          setIsBulkProcessing(false);
      }
  };

  const handleRetryRequest = async (id: string) => {
    toast({ title: "Retrying...", description: "Attempting to restart download." });
    try {
        const res = await fetch('/api/request/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        if (res.ok) fetchRequests();
        else toast({ title: "Retry Failed", variant: "destructive" });
    } catch (e) { toast({ title: "Error", variant: "destructive" }); }
  }

  const handleManualImport = async (requestId: string, torrentName: string, torrentId: string) => {
    setImporting(torrentName)
    try {
      const res = await fetch('/api/admin/manual-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, torrentName, torrentId }) })
      if (res.ok) {
        toast({ title: "Import Successful" });
        fetchAll();
      } else toast({ title: "Import Failed", variant: "destructive" });
    } catch (e) { toast({ title: "Error", variant: "destructive" }); } finally { setImporting(null); }
  }

  const handleAutoImport = async (torrentName: string, torrentId: string) => {
      setImporting(torrentName);
      try {
          const res = await fetch('/api/admin/download/auto-import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ torrentName, torrentId })
          });
          if (res.ok) {
              toast({ title: "Auto-Import Successful", description: "Comic imported into the 'Other' library folder." });
              fetchAll();
          } else {
              toast({ title: "Import Failed", variant: "destructive" });
          }
      } catch (e) {
          toast({ title: "Error", variant: "destructive" });
      } finally {
          setImporting(null);
      }
  }

  const handleIgnoreDownload = async (torrentId: string) => {
      setIgnoringId(torrentId);
      try {
          const res = await fetch('/api/admin/download/ignore', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ downloadId: torrentId })
          });
          if (res.ok) {
              toast({ title: "Download Ignored", description: "This item has been hidden from Omnibus." });
              setTorrents(prev => prev.filter(t => t.id !== torrentId));
          }
      } catch (e) {
          toast({ title: "Error", variant: "destructive" });
      } finally {
          setIgnoringId(null);
      }
  }

  const initiateDeleteRequest = (id: string, name: string) => {
    setRequestToDelete({ id, name });
    setDeleteConfirmOpen(true);
  }

  const handleConfirmedDelete = async () => {
    if (!requestToDelete) return;
    setIsDeleting(true);
    try {
        const res = await fetch(`/api/admin/requests?id=${requestToDelete.id}`, { method: 'DELETE' });
        if (res.ok) {
            toast({ title: "Request Deleted" });
            setRequests(prev => prev.filter(r => r.id !== requestToDelete.id));
            setDeleteConfirmOpen(false);
        } else throw new Error("Failed to delete");
    } catch (error: unknown) { toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" }); } 
    finally { setIsDeleting(false); setRequestToDelete(null); }
  }

const mappedRequests = requests.map(req => {
      let liveStatus = req.status;
      let liveProgress = req.progress;

      if (req.status === 'DOWNLOADING') {
          let match = null;
          
          if (req.downloadLink && !req.downloadLink.startsWith('http')) {
              match = torrents.find((d: any) => d.id?.toLowerCase() === req.downloadLink?.toLowerCase());
          }
          if (!match && req.activeDownloadName) {
              match = torrents.find((d: any) => d.name === req.activeDownloadName);
          }
          // FIX: Strict Smart Fuzzy Match for UI updates
          if (!match && req.activeDownloadName) {
              match = torrents.find((d: any) => {
                  const reqNameLower = req.activeDownloadName.toLowerCase();
                  const torNameLower = d.name.toLowerCase();

                  const reqNumMatch = reqNameLower.match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i);
                  const reqNum = reqNumMatch ? parseFloat(reqNumMatch[1]) : null;

                  if (reqNum !== null) {
                      const numRegex = new RegExp(`(?:#|\\bissue\\s*|\\bvol(?:ume)?\\s*|\\b0*)${reqNum}\\b`, 'i');
                      if (!numRegex.test(torNameLower)) return false;
                  }

                  let cleanReqName = reqNameLower;
                  if (reqNumMatch) cleanReqName = cleanReqName.replace(reqNumMatch[0], '');
                  
                  const reqWords = cleanReqName.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2);
                  const torWords = torNameLower.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2);
                  
                  if (reqWords.length === 0) return false;
                  let matches = 0;
                  reqWords.forEach((w: string) => { if (torWords.includes(w)) matches++; });
                  
                  return (matches / reqWords.length) >= 0.8;
              });
          }

          if (match) {
              liveProgress = parseFloat(match.progress);
              if (['pausedDL', 'stalledDL', 'error'].includes(match.status)) liveStatus = 'STALLED';
              else if (match.status === 'uploading' || match.status === 'stalledUP' || liveProgress >= 100) {
                  liveStatus = 'IMPORTING'; 
                  liveProgress = 100;
              }
          }
      }
      return { ...req, status: liveStatus, progress: liveProgress };
  });

  // Ensure IMPORTING is included so it stays visible while the cron job runs
  const pendingRequests = mappedRequests.filter(r => ['PENDING', 'MANUAL_DDL', 'DOWNLOADING', 'STALLED', 'FAILED', 'ERROR', 'IMPORTING'].includes(r.status));
  const pendingApprovals = mappedRequests.filter(r => r.status === 'PENDING_APPROVAL');

  // Filter out any torrents that cleanly match a request so they aren't double-listed in the UI
  const activeList = torrents.filter(t => {
      if (parseFloat(t.progress) >= 100) return false;
      const isMatched = mappedRequests.some(r => 
          (r.status === 'DOWNLOADING' || r.status === 'IMPORTED' || r.status === 'STALLED' || r.status === 'IMPORTING') &&
          (r.downloadLink?.toLowerCase() === t.id.toLowerCase() || r.activeDownloadName === t.name)
      );
      return !isMatched;
  });

  const completedUnmatched = torrents.filter(t => {
      if (parseFloat(t.progress) < 100) return false;
      const isMatched = mappedRequests.some(r => 
          (r.status === 'DOWNLOADING' || r.status === 'IMPORTED' || r.status === 'COMPLETED' || r.status === 'IMPORTING') &&
          (r.downloadLink?.toLowerCase() === t.id.toLowerCase() || r.activeDownloadName === t.name)
      );
      return !isMatched;
  });

  return (
    <div className="container mx-auto py-6 sm:py-10 px-4 sm:px-6 space-y-8 sm:space-y-10 transition-colors duration-300">
      
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Admin Dashboard</h1>
        <Button variant="outline" size="sm" onClick={fetchAll} disabled={statsLoading || reqsLoading || downloadsLoading} className="h-10 sm:h-9 w-full sm:w-auto border-border hover:bg-muted text-foreground transition-colors">
            {(statsLoading || reqsLoading || downloadsLoading) ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Refresh Status
        </Button>
      </div>

      {errorMessage && !downloadsLoading && (
        <Alert variant="destructive" className="animate-in fade-in slide-in-from-top-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Connection Issue</AlertTitle>
          <AlertDescription>{errorMessage}. Please verify your settings in the Download Clients tab.</AlertDescription>
        </Alert>
      )}
      
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-6">
          {statsLoading ? (
            <><StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton /></>
          ) : (
            <>
              <Card className="shadow-sm border-border bg-background">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium text-foreground">Total Requests</CardTitle>
                  <TrendingUp className="h-4 w-4 text-muted-foreground hidden sm:block" />
                </CardHeader>
                <CardContent>
                  <div className="text-xl sm:text-2xl font-bold text-foreground">{stats.totalRequests}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">All time requests</p>
                </CardContent>
              </Card>

              <Card className="shadow-sm border-border bg-background">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium text-foreground">Active Downloads</CardTitle>
                  <Download className="h-4 w-4 text-muted-foreground hidden sm:block" />
                </CardHeader>
                <CardContent>
                  <div className="text-xl sm:text-2xl font-bold text-primary">{activeList.length + pendingRequests.length}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">Queue & searches</p>
                </CardContent>
              </Card>

              <Card className="shadow-sm border-green-200 bg-green-50/30 dark:border-green-900/50 dark:bg-green-900/10">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium">Completed (30d)</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-green-600 hidden sm:block" />
                </CardHeader>
                <CardContent>
                  <div className="text-xl sm:text-2xl font-bold text-green-600 dark:text-green-400">{stats.completed30d}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">Finished in last 30 days</p>
                </CardContent>
              </Card>

              <Card className="shadow-sm border-red-200 bg-red-50/30 dark:border-red-900/50 dark:bg-red-900/10">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium">Failed (30d)</CardTitle>
                  <XCircle className="h-4 w-4 text-red-600 hidden sm:block" />
                </CardHeader>
                <CardContent>
                  <div className="text-xl sm:text-2xl font-bold text-red-600 dark:text-red-400">{stats.failed30d}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">Errors in last 30 days</p>
                </CardContent>
              </Card>

              <Card className="shadow-sm border-border bg-background">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium text-foreground">Total Users</CardTitle>
                  <Users className="h-4 w-4 text-muted-foreground hidden sm:block" />
                </CardHeader>
                <CardContent>
                  <div className="text-xl sm:text-2xl font-bold text-foreground">{stats.totalUsers}</div>
                  <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">Registered accounts</p>
                </CardContent>
              </Card>

              {/* System Health / Updates Card */}
              {updateData?.updateAvailable ? (
                <Link href="/admin/updates" className="block transition-transform hover:scale-[1.02] h-full">
                  <Card className="shadow-sm border-primary bg-primary/10 hover:bg-primary/20 transition-colors cursor-pointer h-full">
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-xs sm:text-sm font-medium text-foreground">System Health</CardTitle>
                      <span className="flex h-2.5 w-2.5 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                      </span>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl sm:text-2xl font-bold text-primary">Update Available!</div>
                      <p className="text-[10px] sm:text-xs text-muted-foreground pt-1 font-medium">
                        v{updateData.currentVersion} &rarr; <span className="text-foreground font-bold">v{updateData.latestVersion}</span>
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ) : (
                <Link href="/admin/updates" className="block transition-transform hover:scale-[1.02] h-full">
                  <Card className={`shadow-sm transition-colors duration-500 h-full hover:border-primary/50 ${
                      stats.healthStatus === "HEALTHY" && systemHealthy ? "border-green-200 bg-green-50/30 dark:border-green-900/50 dark:bg-green-900/10" : 
                      stats.healthStatus === "WARNING" ? "border-amber-200 bg-amber-50/30 dark:border-amber-900/50 dark:bg-amber-900/10" :
                      "border-red-200 bg-red-50/30 dark:border-red-900/50 dark:bg-red-900/10"
                  }`}>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-xs sm:text-sm font-medium">System Health</CardTitle>
                      <Activity className={`h-4 w-4 hidden sm:block ${
                          stats.healthStatus === "HEALTHY" && systemHealthy ? "text-green-600" : 
                          stats.healthStatus === "WARNING" ? "text-amber-600" : "text-red-600"
                      }`} />
                    </CardHeader>
                    <CardContent>
                      <div className={`text-xl sm:text-2xl font-bold ${
                          stats.healthStatus === "HEALTHY" && systemHealthy ? "text-green-600" : 
                          stats.healthStatus === "WARNING" ? "text-amber-600" : "text-red-600"
                      }`}>
                        {stats.healthStatus === "HEALTHY" && systemHealthy ? "Healthy" : 
                         stats.healthStatus === "WARNING" ? "Warning" : "Degraded"}
                      </div>
                      <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">
                        v{updateData?.currentVersion || "1.0.0"} • {stats.healthStatus === "HEALTHY" && systemHealthy ? "All systems operational" : 
                         stats.healthStatus === "WARNING" ? `${stats.failureRate}% failure rate detected` : 
                         `Critical failure rate: ${stats.failureRate}%`}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              )}
            </>
          )}
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <Settings className="w-5 h-5 text-foreground" />
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Control Panel</h2>
        </div>
        <Card className="shadow-sm border-border overflow-hidden bg-background">
          <CardContent className="p-0">
            <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border">
              
              <div className="p-2 sm:p-4 space-y-1 sm:space-y-2">
                <h4 className="text-[10px] sm:text-xs font-black text-muted-foreground uppercase tracking-wider mb-1 sm:mb-2 px-2 pt-2">Library Management</h4>
                <Link href="/admin/smart-match" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors"><Sparkles className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Smart Matcher</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Auto-scan and bulk match metadata.</p>
                  </div>
                </Link>
                <Link href="/admin/diagnostics" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors"><ShieldAlert className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Diagnostics</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Detect orphaned files & ghost records.</p>
                  </div>
                </Link>
                <Link href="/admin/reports" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors"><AlertTriangle className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Reported Issues</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Review user reports for broken files.</p>
                  </div>
                </Link>
              </div>

              <div className="p-2 sm:p-4 space-y-1 sm:space-y-2">
                <h4 className="text-[10px] sm:text-xs font-black text-muted-foreground uppercase tracking-wider mb-1 sm:mb-2 px-2 pt-2">System & Monitoring</h4>
                <Link href="/admin/analytics" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors"><BarChart3 className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Analytics & Insights</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Storage, usage, and system health.</p>
                  </div>
                </Link>
                <Link href="/admin/jobs" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors"><Calendar className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Scheduled Jobs</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Manage background automation.</p>
                  </div>
                </Link>
                <Link href="/admin/logs" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors"><FileText className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">System Logs</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">View activity and debug issues.</p>
                  </div>
                </Link>
              </div>

              <div className="p-2 sm:p-4 space-y-1 sm:space-y-2">
                <h4 className="text-[10px] sm:text-xs font-black text-muted-foreground uppercase tracking-wider mb-1 sm:mb-2 px-2 pt-2">Configuration & Access</h4>
                <Link href="/admin/settings" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-muted p-2 rounded-md group-hover:bg-muted/80 transition-colors"><Settings className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Settings</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Configure clients, API keys, paths.</p>
                  </div>
                </Link>
                <Link href="/admin/users" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-muted p-2 rounded-md group-hover:bg-muted/80 transition-colors"><Users className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Users</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Manage accounts and roles.</p>
                  </div>
                </Link>
                <Link href="/admin/trophies" className="flex items-start gap-3 group hover:bg-muted/50 p-3 rounded-md transition-colors">
                  <div className="bg-muted p-2 rounded-md group-hover:bg-muted/80 transition-colors"><Trophy className="w-5 h-5 text-primary" /></div>
                  <div className="pt-0.5">
                    <h5 className="text-sm sm:text-base font-bold leading-none group-hover:text-primary transition-colors text-foreground">Trophies</h5>
                    <p className="text-[11px] sm:text-xs text-muted-foreground leading-snug mt-1.5">Manage platform achievements.</p>
                  </div>
                </Link>
              </div>

            </div>
          </CardContent>
        </Card>
      </div>

      {pendingApprovals.length > 0 && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-1">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-500" />
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Requests Awaiting Approval</h2>
              <Badge className="bg-orange-500 text-white ml-2">{pendingApprovals.length}</Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <Button 
                variant="outline" 
                size="sm" 
                className="h-10 sm:h-9 flex-1 sm:flex-none border-border hover:bg-muted text-foreground"
                onClick={() => {
                  if (selectedRequests.size === pendingApprovals.length) setSelectedRequests(new Set());
                  else setSelectedRequests(new Set(pendingApprovals.map(r => r.id)));
                }}
              >
                {selectedRequests.size === pendingApprovals.length ? "Deselect All" : "Select All"}
              </Button>
              
              {selectedRequests.size > 0 && (
                <>
                  <Button size="sm" className="h-10 sm:h-9 flex-1 sm:flex-none bg-green-600 hover:bg-green-700 text-white font-bold" disabled={isBulkProcessing} onClick={() => handleBulkApprovalAction('PENDING')}>
                    {isBulkProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <ThumbsUp className="w-4 h-4 mr-1" />}
                    Approve ({selectedRequests.size})
                  </Button>
                  <Button size="sm" variant="destructive" className="h-10 sm:h-9 flex-1 sm:flex-none font-bold border-red-200 dark:border-red-900/50" disabled={isBulkProcessing} onClick={() => handleBulkApprovalAction('CANCELLED')}>
                    {isBulkProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <ThumbsDown className="w-4 h-4 mr-1" />}
                    Deny ({selectedRequests.size})
                  </Button>
                </>
              )}
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {pendingApprovals.map((req) => (
              <Card 
                key={req.id} 
                className={`relative overflow-hidden shadow-md transition-all hover:shadow-lg cursor-pointer ${
                  selectedRequests.has(req.id) 
                  ? 'ring-2 ring-primary border-primary bg-primary/10' 
                  : 'border-orange-200 bg-orange-50/20 dark:border-orange-900/40 dark:bg-orange-900/10'
                }`}
                onClick={() => toggleSelection(req.id)}
              >
                <div className="absolute top-2 right-2 z-10">
                  <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${selectedRequests.has(req.id) ? 'bg-primary border-primary text-primary-foreground' : 'bg-background/80 border-border text-transparent'}`}>
                    <Check className="w-3.5 h-3.5" />
                  </div>
                </div>

                <CardContent className="p-3 sm:p-4 flex h-36 sm:h-44 gap-3 sm:gap-4">
                  <div className="w-20 sm:w-24 h-full bg-muted shrink-0 rounded-lg overflow-hidden border border-border flex items-center justify-center">
                    {req.imageUrl ? <img src={req.imageUrl} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-8 h-8 text-muted-foreground/50" />}
                  </div>

                  <div className="flex-1 flex flex-col justify-between min-w-0">
                    <div className="space-y-1.5 pr-6">
                      <h3 className="font-bold text-sm truncate text-foreground" title={req.seriesName}>{req.seriesName}</h3>
                      <div className="space-y-1">
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1.5"><Users className="w-3 h-3 text-primary shrink-0" /> <span className="truncate">Requested by: <span className="font-bold text-foreground">{req.userName}</span></span></p>
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1.5"><Calendar className="w-3 h-3 text-muted-foreground shrink-0" /> <span className="truncate">{new Date(req.createdAt).toLocaleString()}</span></p>
                      </div>
                    </div>

                    <div className="flex gap-2 pt-2">
                      <Button 
                        size="sm" 
                        className="flex-1 h-10 sm:h-8 bg-green-600 hover:bg-green-700 text-white font-bold text-xs sm:text-[10px] shadow-sm" 
                        onClick={(e) => { e.stopPropagation(); handleApprovalAction(req.id, 'PENDING'); }}
                      >
                        <ThumbsUp className="w-3.5 h-3.5 sm:w-3 sm:h-3 mr-1" /> Approve
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1 h-10 sm:h-8 border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20 font-bold text-xs sm:text-[10px] shadow-sm" 
                        onClick={(e) => { e.stopPropagation(); handleApprovalAction(req.id, 'CANCELLED'); }}
                      >
                        <ThumbsDown className="w-3.5 h-3.5 sm:w-3 sm:h-3 mr-1" /> Deny
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
            <Activity className="w-5 h-5 text-primary" />
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Active Download Queue</h2>
        </div>

        <Card className={`shadow-sm bg-primary/5 transition-all ${pendingRequests.length === 0 && activeList.length === 0 ? 'border border-dashed border-primary/30' : 'border border-primary/20'}`}>
          <CardContent className="p-2 sm:p-4 space-y-4">
              <div className="flex justify-between items-center hidden sm:flex">
                  <p className="text-sm text-primary/80 px-1">Monitor live transfers from your download clients and pending requests.</p>
              </div>

              {downloadsLoading || reqsLoading ? (
                  <QueueSkeleton />
              ) : (
                  <div className="space-y-3 sm:space-y-4">
                      {pendingRequests.length === 0 && activeList.length === 0 && (
                          <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
                              <div className="bg-muted p-4 rounded-full"><Download className="h-10 w-10 text-muted-foreground/50" /></div>
                              <p className="text-sm font-bold text-foreground">No active downloads or pending searches.</p>
                          </div>
                      )}

                      {pendingRequests.map((req) => {
                          const isExhausted = ['STALLED', 'FAILED', 'ERROR'].includes(req.status) && (req.retryCount >= 3);

                          return (
                          <div key={req.id} className={`flex flex-col md:flex-row items-start md:items-center justify-between p-3 sm:p-4 bg-background border rounded-lg shadow-sm gap-3 sm:gap-4 transition-all hover:border-primary/50 ${isExhausted ? 'border-red-300 dark:border-red-900 bg-red-50/30 dark:bg-red-900/10' : 'border-border'}`}>
                              
                              <div className="flex gap-3 w-full md:w-auto md:flex-1 min-w-0">
                                <div className="w-10 h-14 sm:w-12 sm:h-16 bg-muted shrink-0 rounded overflow-hidden border border-border flex items-center justify-center">
                                  {req.imageUrl ? (
                                      <img src={req.imageUrl} className="w-full h-full object-cover" alt="" />
                                  ) : (
                                      <ImageIcon className="w-4 h-4 text-muted-foreground/50" />
                                  )}
                                </div>

                                <div className="flex-1 min-w-0 flex flex-col justify-center">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-bold text-sm sm:text-base truncate text-foreground">{req.seriesName}</span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] sm:text-xs text-muted-foreground">
                                        <Badge variant={req.status === 'MANUAL_DDL' ? 'destructive' : req.status === 'IMPORTING' ? 'secondary' : 'outline'} className={`text-[9px] uppercase font-black px-1.5 py-0 ${req.status === 'STALLED' ? 'border-orange-500 text-orange-600' : ''} ${isExhausted ? 'border-red-500 text-red-600' : ''} ${req.status === 'IMPORTING' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-300' : ''}`}>
                                            {req.status === 'MANUAL_DDL' ? 'GETCOMICS' : req.status === 'IMPORTING' ? 'IMPORTING...' : req.status}
                                        </Badge>
                                        <span className="flex items-center gap-1 font-medium truncate"><Users className="w-3 h-3" /> {req.userName}</span>
                                        {req.status === 'DOWNLOADING' && (
                                            <span className="font-mono text-primary font-bold bg-primary/10 px-1.5 rounded">{req.progress}%</span>
                                        )}
                                        {(req.retryCount > 0 && req.status !== 'DOWNLOADING') && (
                                            <span className={`font-mono font-bold px-1.5 rounded ${isExhausted ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' : 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400'}`}>
                                                Retry {req.retryCount}/3
                                            </span>
                                        )}
                                    </div>
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end pt-1 md:pt-0 border-t md:border-t-0 border-border md:border-transparent mt-1 md:mt-0">
                                  {isExhausted && (
                                      <div className="text-[10px] text-red-600 bg-red-50 dark:bg-red-900/20 px-2 py-1.5 rounded border border-red-200 dark:border-red-900 flex items-center gap-1 font-bold animate-pulse">
                                          <AlertTriangle className="w-3 h-3 hidden sm:block" /> Needs Admin
                                      </div>
                                  )}
                                  {req.status === 'MANUAL_DDL' && (
                                      <Button size="sm" variant="outline" asChild className="h-10 sm:h-8 text-xs font-bold flex-1 md:flex-none border-border hover:bg-muted text-foreground">
                                          <a href={req.downloadLink} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 mr-1" /> Link</a>
                                      </Button>
                                  )}
                                  {['STALLED', 'FAILED', 'ERROR'].includes(req.status) && (
                                      <Button size="sm" variant="outline" onClick={() => handleRetryRequest(req.id)} className="h-10 sm:h-8 text-xs font-bold text-primary border-primary/30 bg-primary/10 hover:bg-primary/20 flex-1 md:flex-none">
                                          <RefreshCw className="w-3 h-3 mr-1" /> Retry
                                      </Button>
                                  )}
                                  <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => initiateDeleteRequest(req.id, req.seriesName)}>
                                      <Trash2 className="w-4 h-4 sm:w-4 sm:h-4" />
                                  </Button>
                              </div>
                          </div>
                      )})}

                      {activeList.map((t) => {
                          return (
                          <div key={t.id} className="flex flex-col md:flex-row items-start md:items-center justify-between p-3 sm:p-4 bg-background border border-border rounded-lg shadow-sm gap-3 sm:gap-4 transition-all hover:border-primary/50">
                              
                              <div className="flex gap-3 w-full md:w-auto md:flex-1 min-w-0">
                                <div className="w-10 h-14 sm:w-12 sm:h-16 bg-muted shrink-0 rounded overflow-hidden border border-border flex items-center justify-center">
                                      <ImageIcon className="w-4 h-4 text-muted-foreground/50" />
                                </div>

                                <div className="flex-1 min-w-0 flex flex-col justify-center">
                                    <p className="font-bold text-sm sm:text-base truncate text-foreground mb-1" title={t.name}>{t.name}</p>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                        <div className="flex items-center gap-2">
                                          <Badge variant="secondary" className="text-[9px] h-4 uppercase tracking-tighter font-black bg-muted border-border">{t.clientName}</Badge>
                                          <span className="text-[10px] text-muted-foreground font-mono font-medium">{t.size}</span>
                                          <Badge variant="outline" className="text-[9px] uppercase tracking-tighter text-primary border-primary/30">{t.status}</Badge>
                                        </div>
                                    </div>
                                </div>
                              </div>
                              
                              <div className="w-full md:w-48 flex flex-col items-end gap-1.5 shrink-0 pt-1 md:pt-0">
                                  <div className="w-full flex justify-between md:justify-end items-center">
                                      <span className="text-[10px] text-muted-foreground font-medium md:hidden"><Calendar className="w-3 h-3 inline mr-1" /> Active</span>
                                      <span className="font-mono font-black text-primary text-xs sm:text-sm">{t.progress}%</span>
                                  </div>
                                  <div className="w-full bg-muted h-1.5 sm:h-2 rounded-full overflow-hidden shadow-inner border border-border/50">
                                      <div className="bg-primary shadow-sm shadow-primary/50 h-full transition-all duration-500 ease-out" style={{ width: `${t.progress}%` }} />
                                  </div>
                              </div>
                          </div>
                      )})}
                  </div>
              )}
          </CardContent>
        </Card>
      </div>

      {completedUnmatched.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 px-1">
                <HardDrive className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Unmatched Finished Downloads</h2>
            </div>
            
            <Card className="shadow-sm border-orange-200 bg-orange-50/20 dark:border-orange-900/40 dark:bg-orange-900/5">
                <CardContent className="p-3 sm:p-4 space-y-4">
                    <p className="text-xs sm:text-sm text-orange-700 dark:text-orange-300 px-1">These files are finished but not linked to a request. You can manually link them, auto-import them as new series, or ignore them.</p>
                    {completedUnmatched.map((torrent) => (
                        <div key={torrent.id} className="flex flex-col xl:flex-row items-start xl:items-center justify-between p-3 sm:p-4 bg-background border border-border rounded-lg shadow-sm gap-3 sm:gap-4">
                            <div className="flex-1 min-w-0 w-full">
                                <p className="font-mono text-xs sm:text-sm truncate font-bold text-foreground break-all whitespace-normal" title={torrent.name}>{torrent.name}</p>
                                <Badge variant="outline" className="text-[9px] mt-1.5 uppercase tracking-tighter border-border text-muted-foreground">{torrent.clientName}</Badge>
                            </div>
                            
                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 w-full xl:w-auto mt-2 xl:mt-0">
                                <div className="flex items-center gap-2 w-full sm:w-auto">
                                    <select 
                                        className="flex-1 sm:w-56 h-12 sm:h-9 rounded-md border border-input bg-background px-3 py-1 text-sm sm:text-xs shadow-sm text-foreground focus:ring-2 focus:ring-primary focus:outline-none"
                                        id={`select-${torrent.id}`}
                                    >
                                        <option value="">Link to request...</option>
                                        {requests.map(r => (
                                            <option key={r.id} value={r.id}>
                                                {r.seriesName} ({r.userName})
                                            </option>
                                        ))}
                                    </select>
                                    <Button 
                                        size="sm" 
                                        className="h-12 sm:h-9 px-4 shrink-0 font-bold bg-primary hover:bg-primary/90 text-primary-foreground"
                                        disabled={importing === torrent.name}
                                        onClick={() => {
                                            const select = document.getElementById(`select-${torrent.id}`) as HTMLSelectElement;
                                            if (select && select.value) handleManualImport(select.value, torrent.name, torrent.id);
                                            else toast({ title: "Select a request", description: "You must choose which comic this file belongs to." });
                                        }}
                                    >
                                        {importing === torrent.name ? <Loader2 className="w-4 h-4 animate-spin" /> : "Link"}
                                    </Button>
                                </div>
                                
                                <div className="hidden sm:block h-6 w-px bg-border mx-1" />

                                <div className="flex justify-end gap-2 w-full sm:w-auto">
                                    <Button 
                                        size="sm" 
                                        variant="secondary" 
                                        className="h-12 sm:h-9 text-xs font-bold shadow-sm flex-1 sm:flex-none hover:bg-muted text-foreground" 
                                        disabled={importing === torrent.name} 
                                        onClick={() => handleAutoImport(torrent.name, torrent.id)}
                                        title="Create a new folder and import automatically"
                                    >
                                        Auto-Import
                                    </Button>
                                    <Button 
                                        size="sm" 
                                        variant="outline" 
                                        className="h-12 sm:h-9 w-12 sm:w-auto px-0 sm:px-3 text-xs font-bold border-border text-muted-foreground hover:bg-muted hover:text-foreground shrink-0" 
                                        disabled={ignoringId === torrent.id} 
                                        onClick={() => handleIgnoreDownload(torrent.id)}
                                        title="Hide this file from Omnibus"
                                    >
                                        {ignoringId === torrent.id ? <Loader2 className="w-4 h-4 animate-spin mr-0 sm:mr-1" /> : <EyeOff className="w-4 h-4 mr-0 sm:mr-1" />}
                                        <span className="hidden sm:inline">Ignore</span>
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ))}
                </CardContent>
            </Card>
          </div>
      )}

      <AdminRequestManagement />

      <ConfirmationDialog 
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={handleConfirmedDelete}
        isLoading={isDeleting}
        title="Stop Monitoring Request?"
        description={`This will remove "${requestToDelete?.name}" from your active tracking list and stop any pending searches. The file will not be deleted if it has already finished downloading.`}
        confirmText="Remove Request"
      />
    </div>
  )
}