"use client"

import { useState, useEffect, useMemo } from "react"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, Search, RefreshCw, Clock, CheckCircle2, Calendar, FileText, ChevronLeft, ChevronRight, Info, List, ImageIcon } from "lucide-react" // Added ImageIcon
import { useToast } from "@/components/ui/use-toast"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// --- Helper Component: Individual Request Card ---
function RequestCard({ req, getStatusColor }: { req: any, getStatusColor: (status: string) => string }) {
  const [desc, setDesc] = useState<string | null>(null)
  const [loadingDesc, setLoadingDesc] = useState(false)
  const [showDesc, setShowDesc] = useState(false)

  const handleShowDesc = async () => {
    if (showDesc) {
        setShowDesc(false);
        return;
    }
    setShowDesc(true);
    if (!desc && req.volumeId) {
        setLoadingDesc(true);
        try {
            const issueMatch = req.seriesName?.match(/#(\d+)/);
            if (issueMatch) {
                const targetIssueNum = parseFloat(issueMatch[1]);
                const [volRes, issuesRes] = await Promise.all([
                    fetch(`/api/issue-details?id=${req.volumeId}&type=volume`),
                    fetch(`/api/series-issues?volumeId=${req.volumeId}`)
                ]);
                const volData = await volRes.json();
                const issuesData = await issuesRes.json();
                const specificIssue = issuesData.results?.find((i: any) => parseFloat(i.issueNumber) === targetIssueNum);
                const finalDesc = specificIssue?.description || volData.description;
                setDesc(finalDesc ? finalDesc.trim() : "No synopsis available.");
            } else {
                const res = await fetch(`/api/issue-details?id=${req.volumeId}&type=volume`);
                const data = await res.json();
                setDesc(data.description ? data.description.trim() : "No synopsis available.");
            }
        } catch (e) {
            setDesc("Failed to load synopsis.");
        } finally {
            setLoadingDesc(false);
        }
    }
  }

  const displayName = (req.seriesName || "Unknown Request").replace(/\.(cbz|cbr|zip)$/i, '');
  const isCompleted = ['IMPORTED', 'COMPLETED'].includes(req.status);

  return (
    <Card className="shadow-sm hover:border-primary/50 transition-colors overflow-hidden dark:border-slate-800">
      <CardContent className="p-4 flex flex-col sm:flex-row gap-6">
        
        {/* Cover Image - Unified with Library Style */}
        <div className="w-full sm:w-32 shrink-0 aspect-[2/3] bg-slate-100 dark:bg-slate-900 rounded-xl overflow-hidden border dark:border-slate-800 relative shadow-sm flex items-center justify-center">
            {req.imageUrl ? (
                <img src={req.imageUrl} alt={displayName} className="object-cover w-full h-full" />
            ) : (
                <ImageIcon className="w-10 h-10 text-slate-300 dark:text-slate-700" />
            )}
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2 mb-4">
                <div className="space-y-1">
                    <h3 className="font-bold text-lg sm:text-xl leading-tight line-clamp-2 dark:text-slate-100" title={displayName}>{displayName}</h3>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={`${getStatusColor(req.status)} text-[10px] font-bold uppercase tracking-wider`}>
                            {req.status === 'PENDING_APPROVAL' ? 'Needs Approval' : req.status === 'MANUAL_DDL' ? 'GETCOMICS' : req.status}
                        </Badge>
                        {req.status === 'DOWNLOADING' && <span className="text-[11px] font-mono text-blue-600 dark:text-blue-400 font-bold bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded">{req.progress}%</span>}
                        {isCompleted && <span className="text-[11px] text-green-700 dark:text-green-400 flex items-center gap-1 font-bold bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded"><CheckCircle2 className="w-3 h-3"/> Ready in Library</span>}
                    </div>
                </div>
            </div>

            <div className="flex-1">
                <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={handleShowDesc} 
                    className="h-7 px-2 text-xs font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20 -ml-2 mb-1"
                >
                    <Info className="w-3.5 h-3.5 mr-1" /> {showDesc ? "Hide Synopsis" : "Read Synopsis"}
                </Button>
                {showDesc && (
                    <div className="text-sm text-muted-foreground leading-relaxed bg-slate-50 dark:bg-slate-900/50 p-4 rounded-md border dark:border-slate-800 mt-2 animate-in fade-in slide-in-from-top-2">
                        {loadingDesc ? (
                            <span className="flex items-center gap-2 text-xs font-medium"><Loader2 className="w-3 h-3 animate-spin text-blue-500"/> Fetching data...</span>
                        ) : (
                            desc
                        )}
                    </div>
                )}
            </div>

            <div className="mt-4 pt-4 border-t dark:border-slate-800 flex flex-wrap gap-x-6 gap-y-2 text-[11px] font-medium">
                <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                    <Calendar className="w-3.5 h-3.5" />
                    Requested: {new Date(req.createdAt).toLocaleDateString()}
                </div>
                {isCompleted && req.updatedAt && (
                    <div className="flex items-center gap-1.5 text-green-600 dark:text-green-500">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Completed: {new Date(req.updatedAt).toLocaleDateString()}
                    </div>
                )}
            </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function RequestsPage() {
  const { data: session } = useSession()
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  
  const [activeTab, setActiveTab] = useState("ALL")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState("5")
  
  const { toast } = useToast()

  const fetchRequests = async () => {
    if (!session?.user?.id) return;
    try {
      const res = await fetch('/api/admin/requests')
      if (res.ok) {
        const data = await res.json()
        const userRequests = data.filter((r: any) => r.userId === session.user.id);
        setRequests(userRequests)
      }
    } catch (e) {
      toast({ title: "Error", description: "Could not load requests.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRequests()
    const interval = setInterval(fetchRequests, 15000) 
    return () => clearInterval(interval)
  }, [session])

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'IMPORTED': case 'COMPLETED': return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
      case 'DOWNLOADING': case 'MANUAL_DDL': return "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800"
      case 'PENDING_APPROVAL': return "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800"
      case 'FAILED': case 'STALLED': case 'ERROR': return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800"
      default: return "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
    }
  }

  const filteredRequests = useMemo(() => {
      return requests.filter(req => {
          if (activeTab === "ALL") return true;
          if (activeTab === "ACTIVE") return ['DOWNLOADING', 'PENDING', 'MANUAL_DDL'].includes(req.status);
          if (activeTab === "PENDING_APPROVAL") return req.status === 'PENDING_APPROVAL';
          if (activeTab === "COMPLETED") return ['IMPORTED', 'COMPLETED'].includes(req.status);
          if (activeTab === "FAILED") return ['FAILED', 'STALLED', 'ERROR'].includes(req.status);
          if (activeTab === "CANCELLED") return req.status === 'CANCELLED';
          return true;
      });
  }, [requests, activeTab]);

  useEffect(() => { setPage(1) }, [activeTab, pageSize]);

  const limit = parseInt(pageSize);
  const totalPages = Math.ceil(filteredRequests.length / limit) || 1;
  const paginatedRequests = filteredRequests.slice((page - 1) * limit, page * limit);

  return (
    <div className="container mx-auto py-10 px-6 space-y-6 max-w-5xl">
      <title>Omnibus - My Requests</title>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My Requests</h1>
          <p className="text-muted-foreground mt-1">
            Track the status and history of your requested comics.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={fetchRequests} disabled={loading} className="h-10 dark:border-slate-700 dark:hover:bg-slate-800">
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                Refresh
            </Button>
            <Link href="/"><Button className="h-10"><Search className="w-4 h-4 mr-2" /> Request More</Button></Link>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full flex overflow-x-auto justify-start sm:justify-center [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] h-auto p-1 bg-slate-100 dark:bg-slate-900 border dark:border-slate-800">
            <TabsTrigger value="ALL" className="px-4 py-2">All</TabsTrigger>
            <TabsTrigger value="ACTIVE" className="px-4 py-2">Active / DL</TabsTrigger>
            <TabsTrigger value="PENDING_APPROVAL" className="px-4 py-2">Pending</TabsTrigger>
            <TabsTrigger value="COMPLETED" className="px-4 py-2">Completed</TabsTrigger>
            <TabsTrigger value="FAILED" className="px-4 py-2">Failed</TabsTrigger>
            <TabsTrigger value="CANCELLED" className="px-4 py-2">Cancelled</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 gap-6 min-h-[400px]">
          {paginatedRequests.map((req) => (
              <RequestCard key={req.id} req={req} getStatusColor={getStatusColor} />
          ))}
          
          {paginatedRequests.length === 0 && !loading && (
             <div className="flex flex-col items-center justify-center py-20 text-center border-2 border-dashed rounded-lg dark:border-slate-800">
               <FileText className="w-10 h-10 text-slate-300 dark:text-slate-700 mb-4" />
               <p className="text-muted-foreground font-medium">No requests found in this category.</p>
             </div>
          )}
      </div>

      {totalPages > 1 && (
          <div className="flex items-center justify-between border-t dark:border-slate-800 pt-6 mt-6">
              <p className="text-sm text-muted-foreground hidden sm:block">
                  Showing {(page - 1) * limit + 1} to {Math.min(page * limit, filteredRequests.length)} of {filteredRequests.length} requests
              </p>
              
              <div className="flex items-center gap-4 w-full sm:w-auto justify-end">
                  <div className="flex items-center gap-2">
                    <Select value={pageSize} onValueChange={setPageSize}>
                      <SelectTrigger className="w-[110px] h-9 bg-white dark:bg-slate-950 dark:border-slate-800 text-xs">
                        <div className="flex items-center gap-2">
                          <List className="w-3 h-3 text-muted-foreground" />
                          <SelectValue placeholder="Show 5" />
                        </div>
                      </SelectTrigger>
                      <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                        <SelectItem value="5">5 per page</SelectItem>
                        <SelectItem value="10">10 per page</SelectItem>
                        <SelectItem value="25">25 per page</SelectItem>
                        <SelectItem value="50">50 per page</SelectItem>
                        <SelectItem value="100">100 per page</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="dark:border-slate-700">
                          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="dark:border-slate-700">
                          Next <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                  </div>
              </div>
          </div>
      )}
    </div>
  )
}