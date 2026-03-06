// src/app/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useSession } from "next-auth/react"
import { RequestSearch } from "@/components/request-search"
import { ComicGrid } from "@/components/comic-grid"
import { ContinueReading } from "@/components/ContinueReading"
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
  UserPlus // Added for the pending users banner
} from "lucide-react" 
import Link from "next/link"

export default function Home() {
  const { data: session } = useSession()
  const [pendingCount, setPendingCount] = useState(0)
  const [openReportsCount, setOpenReportsCount] = useState(0)
  const [manualDownloadsCount, setManualDownloadsCount] = useState(0)
  const [pendingUsersCount, setPendingUsersCount] = useState(0) // NEW: State for pending accounts
  const isAdmin = session?.user?.role === 'ADMIN'

  // State to manage hard cache resets
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Fix title flashing
  useEffect(() => {
    document.title = "Omnibus - Home"
  }, []);

  // Fetch requests, reports, and users to check for pending approvals/issues if the user is an admin
  useEffect(() => {
    if (!isAdmin) return

    const checkAdminAlerts = async () => {
      try {
        // Fetch All Requests
        const resReq = await fetch('/api/admin/requests')
        if (resReq.ok) {
          const data = await resReq.json()
          
          // Count Pending Approvals
          const pending = data.filter((r: any) => r.status === 'PENDING_APPROVAL')
          setPendingCount(pending.length)

          // Count Manual Intervention Required (MANUAL_DDL)
          const manual = data.filter((r: any) => r.status === 'MANUAL_DDL')
          setManualDownloadsCount(manual.length)
        }

        // Fetch Open Reports
        const resRep = await fetch('/api/admin/reports')
        if (resRep.ok) {
          const data = await resRep.json()
          const openReports = data.filter((r: any) => r.status === 'OPEN')
          setOpenReportsCount(openReports.length)
        }

        // NEW: Fetch Users to check for unapproved accounts
        const resUsers = await fetch('/api/admin/users')
        if (resUsers.ok) {
          const data = await resUsers.json()
          const pendingUsers = data.filter((u: any) => !u.isApproved)
          setPendingUsersCount(pendingUsers.length)
        }
      } catch (e) {
        console.error("Failed to check admin alerts", e)
      }
    }

    checkAdminAlerts()
    const interval = setInterval(checkAdminAlerts, 300000)
    return () => clearInterval(interval)
  }, [isAdmin])

  // Hard Refresh Handler
  const handleRefreshData = async () => {
    setIsRefreshing(true);
    try {
        // 1. Tell the backend to rebuild the cache instantly
        await fetch('/api/admin/jobs/trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job: 'popular' }) 
        });
        
        // 2. Trigger the child ComicGrids to pull the fresh cache
        setRefreshSignal(Date.now()); 
    } catch (e) {
        console.error("Failed to refresh data", e);
    } finally {
        setTimeout(() => setIsRefreshing(false), 2000); 
    }
  }

  return (
    <div className="bg-slate-50 dark:bg-slate-950 min-h-full pb-20">
      <div className="container mx-auto px-6 py-12 space-y-10">
        
        {/* Admin Notification Banners */}
        <div className="space-y-4">
          
          {/* NEW: Pending User Accounts (Teal) */}
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

          {/* Pending Approvals (Orange) */}
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

          {/* Manual Downloads Needed (Indigo) */}
          {isAdmin && manualDownloadsCount > 0 && (
            <Alert className="bg-indigo-50 border-indigo-200 dark:bg-indigo-950/20 dark:border-indigo-900/50 animate-in fade-in slide-in-from-top-4">
              <DownloadCloud className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
              <AlertTitle className="text-indigo-800 dark:text-indigo-300 font-bold flex items-center gap-2">
                Manual Downloads Required
                <Badge className="bg-indigo-500 hover:bg-indigo-600 text-white border-none text-[10px] h-5">
                  {manualDownloadsCount}
                </Badge>
              </AlertTitle>
              <AlertDescription className="text-indigo-700/80 dark:text-indigo-400/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                Some issues weren&apos;t found automatically and require manual download from GetComics.
                <Button asChild variant="outline" size="sm" className="border-indigo-300 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:text-indigo-400 dark:hover:bg-indigo-900/40 h-8 font-bold">
                  <Link href="/admin">
                    Open Queue <ArrowRight className="ml-2 h-3 w-3" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Open Issues/Reports (Red) */}
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
             <Button variant="outline" size="sm" onClick={handleRefreshData} disabled={isRefreshing} className="bg-white/50 backdrop-blur-sm dark:bg-slate-900/50 dark:border-slate-800 text-slate-600 dark:text-slate-400">
               {isRefreshing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
               Refresh Data
             </Button>
          </div>

          <h1 className="text-4xl font-extrabold tracking-tight lg:text-5xl text-slate-900 dark:text-slate-100">
            What are we reading today?
          </h1>
          <p className="text-lg text-slate-600 dark:text-slate-400 max-w-xl mx-auto">
            Search for a specific series or discover something new below.
          </p>
          
          <div className="pt-2 max-w-2xl mx-auto relative z-20">
            <RequestSearch />
          </div>

          <div className="md:hidden pt-4 flex justify-center">
             <Button variant="outline" size="sm" onClick={handleRefreshData} disabled={isRefreshing} className="w-full max-w-xs dark:border-slate-800 text-slate-600 dark:text-slate-400">
               {isRefreshing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
               Force Refresh Data
             </Button>
          </div>
        </div>

        {/* Jump Back In Shelf */}
        <div className="w-full relative z-10">
          <ContinueReading />
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