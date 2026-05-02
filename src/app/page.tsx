// src/app/page.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { useSession } from "next-auth/react"
import { RequestSearch } from "@/components/request-search"
import { ComicGrid } from "@/components/comic-grid"
import { ContinueReading } from "@/components/ContinueReading"
import { RecommendationsShelf } from "@/components/recommendations-shelf"
import { RecentlyAdded } from "@/components/recently-added"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  Bell, 
  ArrowRight, 
  RefreshCw, 
  Loader2, 
  AlertTriangle, 
  DownloadCloud,
  UserPlus,
  Flag,
  Rocket,
  X,
  FolderSearch
} from "lucide-react" 
import Link from "next/link"
import { Logger } from "@/lib/logger"
import { getErrorMessage } from "@/lib/utils/error"

export default function Home() {
  const { data: session } = useSession()
  const [pendingCount, setPendingCount] = useState(0)
  const [openReportsCount, setOpenReportsCount] = useState(0)
  const [manualDownloadsCount, setManualDownloadsCount] = useState(0)
  const [pendingUsersCount, setPendingUsersCount] = useState(0)
  const [unmatchedCount, setUnmatchedCount] = useState(0)
  const [updateData, setUpdateData] = useState<{ updateAvailable: boolean, currentVersion: string, latestVersion: string } | null>(null)
  const [showFirstSteps, setShowFirstSteps] = useState(false) 
  const isAdmin = session?.user?.role === 'ADMIN'

  const [refreshSignal, setRefreshSignal] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // --- NEW: Discover Grid Visibility States ---
  const [showPopular, setShowPopular] = useState(true)
  const [showNew, setShowNew] = useState(true)

  const dismissFirstSteps = async () => {
      setShowFirstSteps(false);
      try {
          await fetch('/api/admin/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ settings: { hide_first_steps_banner: 'true' } })
          });
      } catch (e) {
          Logger.log(`Failed to dismiss banner: ${getErrorMessage(e)}`, 'error');
      }
  };
  
  useEffect(() => {
    document.title = "Omnibus - Home"
    
    // --- NEW: Fetch grid visibility settings ---
    fetch('/api/discover?type=settings')
      .then(res => res.json())
      .then(data => {
        if (data.showPopular !== undefined) setShowPopular(data.showPopular)
        if (data.showNew !== undefined) setShowNew(data.showNew)
      })
      .catch(err => Logger.log(`Failed to fetch discover settings: ${getErrorMessage(err)}`, 'error'))
  }, []);

  useEffect(() => {
    if (!isAdmin) return

    const checkAdminAlerts = async () => {
      try {
        const timestamp = Date.now();

        const resConfig = await fetch(`/api/admin/config?_t=${timestamp}`, { cache: 'no-store' });
        if (resConfig.ok) {
            const configData = await resConfig.json();
            const isHidden = configData.settings?.find((s: any) => s.key === 'hide_first_steps_banner')?.value === 'true';
            setShowFirstSteps(!isHidden);
        }

        const resReq = await fetch(`/api/admin/requests?_t=${timestamp}`, { cache: 'no-store' })
        if (resReq.ok) {
          const data = await resReq.json()
          const pending = data.filter((r: any) => r.status === 'PENDING_APPROVAL')
          setPendingCount(pending.length)
          const manual = data.filter((r: any) => r.status === 'MANUAL_DDL')
          setManualDownloadsCount(manual.length)
        }

        const resRep = await fetch(`/api/admin/reports?_t=${timestamp}`, { cache: 'no-store' })
        if (resRep.ok) {
          const data = await resRep.json()
          const openReports = data.filter((r: any) => r.status === 'OPEN')
          setOpenReportsCount(openReports.length)
        }

        const resUsers = await fetch(`/api/admin/users?_t=${timestamp}`, { cache: 'no-store' })
        if (resUsers.ok) {
          const data = await resUsers.json()
          const pendingUsers = data.filter((u: any) => !u.isApproved)
          setPendingUsersCount(pendingUsers.length)
        }

        const resUnmatched = await fetch(`/api/admin/unmatched?_t=${timestamp}`, { cache: 'no-store' })
        if (resUnmatched.ok) {
          const data = await resUnmatched.json()
          setUnmatchedCount(data.length || 0)
        }

        const resUpdate = await fetch(`/api/admin/update-check?_t=${timestamp}`, { cache: 'no-store' })
        if (resUpdate.ok) {
          const data = await resUpdate.json()
          setUpdateData(data)
        }
      } catch (e) {
        console.error("Failed to check admin alerts", e)
      }
    }

    checkAdminAlerts()
    const interval = setInterval(checkAdminAlerts, 300000)
    return () => clearInterval(interval)
  }, [isAdmin])

  useEffect(() => {
      return () => {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      }
  }, []);

  const handleRefreshData = async () => {
    setIsRefreshing(true);
    const requestTime = Date.now();
    try {
        await fetch('/api/admin/jobs/trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job: 'popular' }) 
        });
        
        pollIntervalRef.current = setInterval(async () => {
            try {
                const res = await fetch('/api/admin/job-logs');
                if (res.ok) {
                    const logs = await res.json();
                    const recentJob = logs.find((l: any) => l.jobType === 'DISCOVER_SYNC' && new Date(l.createdAt).getTime() >= requestTime);
                    if (recentJob) {
                        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                        setRefreshSignal(Date.now()); 
                        setIsRefreshing(false);
                    }
                }
            } catch (e) {}
        }, 3000);

        // Safety timeout
        setTimeout(() => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                setIsRefreshing(false);
            }
        }, 5 * 60 * 1000);

    } catch (e) {
        Logger.log(`Failed to refresh data: ${getErrorMessage(e)}`, 'error');
        setIsRefreshing(false);
    }
  }

  return (
    <div className="bg-transparent min-h-full pb-20 transition-colors duration-300">
      <div className="container mx-auto px-6 py-12 space-y-10">
        
        {/* Admin Notification Banners */}
        <div className="space-y-4">

          {isAdmin && showFirstSteps && (
            <Alert className="bg-indigo-50 border-indigo-200 dark:bg-indigo-950/30 dark:border-indigo-900/50 animate-in fade-in slide-in-from-top-4 relative shadow-sm">
              <div className="absolute top-2 right-2">
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-indigo-500 hover:bg-indigo-100 dark:hover:bg-indigo-900/50" onClick={dismissFirstSteps}>
                      <X className="h-4 w-4" />
                  </Button>
              </div>
              <Rocket className="h-5 w-5 text-indigo-600 dark:text-indigo-400 mt-0.5" />
              <AlertTitle className="text-indigo-900 dark:text-indigo-300 font-black text-lg mb-3">
                Welcome to Omnibus! Here are your next steps:
              </AlertTitle>
              <AlertDescription className="text-indigo-800 dark:text-indigo-400/90 space-y-4">
                <p>To populate your library and get everything running smoothly, complete these tasks:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white/50 dark:bg-black/20 p-3 rounded-lg border border-indigo-100 dark:border-indigo-900/30">
                        <div className="font-bold flex items-center gap-2 text-indigo-900 dark:text-indigo-300"><span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">1</span> Library Scan</div>
                        <p className="text-xs mt-1 leading-relaxed">Go to <strong>Admin &rarr; Scheduled Jobs</strong> and run the <em>Library Auto-Scan</em>. This finds your physical files and builds the basic folders.</p>
                    </div>
                    <div className="bg-white/50 dark:bg-black/20 p-3 rounded-lg border border-indigo-100 dark:border-indigo-900/30">
                        <div className="font-bold flex items-center gap-2 text-indigo-900 dark:text-indigo-300"><span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">2</span> Metadata Sync</div>
                        <p className="text-xs mt-1 leading-relaxed">Run the <em>Deep Metadata Sync</em>. <strong>Note:</strong> To prevent API bans, this process is throttled and may take several hours to fully download all covers and synopses.</p>
                    </div>
                    <div className="bg-white/50 dark:bg-black/20 p-3 rounded-lg border border-indigo-100 dark:border-indigo-900/30">
                        <div className="font-bold flex items-center gap-2 text-indigo-900 dark:text-indigo-300"><span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">3</span> Smart-Match</div>
                        <p className="text-xs mt-1 leading-relaxed">Go to <strong>Admin &rarr; Smart Matcher</strong> to automatically resolve any remaining series that didn't have a <code>ComicInfo.xml</code> file.</p>
                    </div>
                    <div className="bg-white/50 dark:bg-black/20 p-3 rounded-lg border border-indigo-100 dark:border-indigo-900/30">
                        <div className="font-bold flex items-center gap-2 text-indigo-900 dark:text-indigo-300"><span className="bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">4</span> Discover Sync</div>
                        <p className="text-xs mt-1 leading-relaxed">Finally, run the <em>Discover Sync</em> job to generate the "Popular" and "New Releases" grids on this dashboard!</p>
                    </div>
                </div>
              </AlertDescription>
            </Alert>
          )}
          
          {isAdmin && updateData?.updateAvailable && (
            <Alert className="bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-900/50 animate-in fade-in slide-in-from-top-4">
              <Rocket className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <AlertTitle className="text-blue-800 dark:text-blue-300 font-bold flex items-center gap-2">
                System Update Available
                <Badge className="bg-blue-500 hover:bg-blue-600 text-white border-none text-[10px] h-5">
                  v{updateData.latestVersion}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-blue-700/80 dark:text-blue-400/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                A new version of Omnibus is available. You are currently running v{updateData.currentVersion}.
                <Button asChild variant="outline" size="sm" className="border-blue-300 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-900/40 h-8 font-bold">
                  <Link href="/admin/updates">
                    View Release Notes <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}
          
          {isAdmin && pendingUsersCount > 0 && (
            <Alert className="bg-teal-50 border-teal-200 dark:bg-teal-950/20 dark:border-teal-900/50 animate-in fade-in slide-in-from-top-4">
              <UserPlus className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <AlertTitle className="text-teal-800 dark:text-teal-300 font-bold flex items-center gap-2">
                New Accounts Pending
                <Badge className="bg-teal-500 hover:bg-teal-600 text-white border-none text-[10px] h-5">
                  {pendingUsersCount}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-teal-700/80 dark:text-teal-400/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                There are new user accounts waiting for your approval to access the library.
                <Button asChild variant="outline" size="sm" className="border-teal-300 text-teal-700 hover:bg-teal-100 dark:border-teal-800 dark:text-teal-400 dark:hover:bg-teal-900/40 h-8 font-bold">
                  <Link href="/admin/users">
                    Review Users <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {isAdmin && pendingCount > 0 && (
            <Alert className="bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-900/50 animate-in fade-in slide-in-from-top-4">
              <Bell className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              <AlertTitle className="text-orange-800 dark:text-orange-300 font-bold flex items-center gap-2">
                Action Required
                <Badge className="bg-orange-500 hover:bg-orange-600 text-white border-none text-[10px] h-5">
                  {pendingCount}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-orange-700/80 dark:text-orange-400/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                There are new comic requests waiting for your approval in the dashboard.
                <Button asChild variant="outline" size="sm" className="border-orange-300 text-orange-700 hover:bg-orange-100 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-900/40 h-8 font-bold">
                  <Link href="/admin">
                    Go to Approvals <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {isAdmin && manualDownloadsCount > 0 && (
            <Alert className="bg-primary/5 border-primary/20 animate-in fade-in slide-in-from-top-4">
              <Flag className="h-4 w-4 text-primary" />
              <AlertTitle className="text-primary font-bold flex items-center gap-2">
                Manual Action Required
                <Badge className="bg-primary hover:bg-primary/90 text-primary-foreground border-none text-[10px] h-5">
                  {manualDownloadsCount}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-primary/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                Users have flagged comics or the system couldn't find them automatically. Manual intervention is required.
                <Button asChild variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10 h-8 font-bold">
                  <Link href="/admin">
                    Open Queue <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {isAdmin && unmatchedCount > 0 && (
            <Alert className="bg-purple-50 border-purple-200 dark:bg-purple-950/20 dark:border-purple-900/50 animate-in fade-in slide-in-from-top-4">
              <FolderSearch className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              <AlertTitle className="text-purple-800 dark:text-purple-300 font-bold flex items-center gap-2">
                Unmatched Files Detected
                <Badge className="bg-purple-500 hover:bg-purple-600 text-white border-none text-[10px] h-5">
                  {unmatchedCount}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-purple-700/80 dark:text-purple-400/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                There are loose files or folders waiting to be matched to ComicVine.
                <Button asChild variant="outline" size="sm" className="border-purple-300 text-purple-700 hover:bg-purple-100 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/40 h-8 font-bold">
                  <Link href="/admin/smart-match">
                    Open Smart Matcher <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {isAdmin && openReportsCount > 0 && (
            <Alert className="bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900/50 animate-in fade-in slide-in-from-top-4">
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
              <AlertTitle className="text-red-800 dark:text-red-300 font-bold flex items-center gap-2">
                Issues Reported
                <Badge className="bg-red-500 hover:bg-red-600 text-white border-none text-[10px] h-5">
                  {openReportsCount}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-red-700/80 dark:text-red-400/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                Users have reported broken files or missing metadata that need your attention.
                <Button asChild variant="outline" size="sm" className="border-red-300 text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/40 h-8 font-bold">
                  <Link href="/admin/reports">
                    Review Reports <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Hero / Search Section */}
        <div className="text-center space-y-6 relative">
          
          <div className="absolute right-0 top-0 hidden md:block z-10">
             <Button variant="outline" size="sm" onClick={handleRefreshData} disabled={isRefreshing} className="bg-muted/50 backdrop-blur-sm border-border text-muted-foreground hover:text-foreground">
               {isRefreshing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
               Refresh Data
             </Button>
          </div>

          <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl text-foreground">
            Explore the multiverse...
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Search for a specific series or discover something new below...
          </p>
          
          <div className="pt-2 max-w-2xl mx-auto relative z-20">
            <RequestSearch />
          </div>

          <div className="md:hidden pt-4 flex justify-center">
             <Button variant="outline" size="sm" onClick={handleRefreshData} disabled={isRefreshing} className="w-full max-w-xs border-border text-muted-foreground hover:text-foreground">
               {isRefreshing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
               Force Refresh Data
             </Button>
          </div>
        </div>

        {/* Jump Back In Shelf */}
        <div className="w-full relative z-10">
          <ContinueReading />
        </div>

        {/* Recommendations Shelf */}
        <div className="w-full relative z-10">
          <RecommendationsShelf />
        </div>

        {/* Recently Added Shelf */}
        <div className="w-full relative z-10">
          <RecentlyAdded />
        </div>

        {/* Popular Issues Grid */}
        {showPopular && <ComicGrid title="Popular Issues" type="popular" refreshSignal={refreshSignal} />}

        {/* New Releases Grid */}
        {showNew && <ComicGrid title="New Releases" type="new" refreshSignal={refreshSignal} />}
        
      </div>
    </div>
  )
}