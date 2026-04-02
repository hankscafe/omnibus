// src/app/page.tsx
"use client"

import { useState, useEffect } from "react"
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
  Rocket
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
  const [updateData, setUpdateData] = useState<{ updateAvailable: boolean, currentVersion: string, latestVersion: string } | null>(null) 
  const isAdmin = session?.user?.role === 'ADMIN'

  const [refreshSignal, setRefreshSignal] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  useEffect(() => {
    document.title = "Omnibus - Home"
  }, []);

  useEffect(() => {
    if (!isAdmin) return

    const checkAdminAlerts = async () => {
      try {
        // --- FIX: Add cache-busting timestamps to prevent stale banners ---
        const timestamp = Date.now();

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

  const handleRefreshData = async () => {
    setIsRefreshing(true);
    try {
        await fetch('/api/admin/jobs/trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job: 'popular' }) 
        });
        setRefreshSignal(Date.now()); 
    } catch (e) {
        Logger.log(`Failed to refresh data: ${getErrorMessage(e)}`, 'error');
    } finally {
        setTimeout(() => setIsRefreshing(false), 2000); 
    }
  }

  // FIX: Applying the Lookbehind Regex fix here to stop the compiler errors and ensure stability
  const extractNumSafely = (clean: string) => {
    const fallbacks = [...clean.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
    if (fallbacks.length > 0) return parseFloat(fallbacks[fallbacks.length - 1][1]);
    return null;
  }

  return (
    <div className="bg-transparent min-h-full pb-20 transition-colors duration-300">
      <div className="container mx-auto px-6 py-12 space-y-10">
        
        {/* Admin Notification Banners */}
        <div className="space-y-4">

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
        <ComicGrid title="Popular Issues" type="popular" refreshSignal={refreshSignal} />

        {/* New Releases Grid */}
        <ComicGrid title="New Releases" type="new" refreshSignal={refreshSignal} />
        
      </div>
    </div>
  )
}