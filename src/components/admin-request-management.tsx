"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { 
  Search, Trash2, ExternalLink, Info, Loader2, ChevronsUpDown, AlertTriangle, 
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Calendar, Users
} from "lucide-react"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"

export function AdminRequestManagement() {
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  
  // Filters
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("ALL")
  const [userFilter, setUserFilter] = useState("ALL")

  // Sorting
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'createdAt', direction: 'desc' })

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // Bulk & Single Deletion Actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [idsToDelete, setIdsToDelete] = useState<string[]>([])
  const [isDeleting, setIsDeleting] = useState(false)

  // Details Modal
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [selectedComicDetails, setSelectedComicDetails] = useState<any>(null)
  const [loadingDetails, setLoadingDetails] = useState(false)

  // Column Resizing State
  const [colWidths, setColWidths] = useState<Record<string, number>>({
    checkbox: 50,
    seriesName: 300,
    userName: 120,
    status: 140,
    createdAt: 100,
    updatedAt: 100,
    actions: 120
  })
  const [isResizing, setIsResizing] = useState<string | null>(null)
  const startXRef = useRef<number>(0)
  const startWidthRef = useRef<number>(0)

  const { toast } = useToast()

  const fetchRequests = async () => {
    try {
      const res = await fetch('/api/admin/requests')
      if (res.ok) setRequests(await res.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRequests()
    const interval = setInterval(fetchRequests, 15000)
    return () => clearInterval(interval)
  }, [])

  const uniqueUsers = useMemo(() => Array.from(new Set(requests.map(r => r.userName))), [requests])

  const filteredRequests = useMemo(() => {
    return requests.filter(req => {
      const matchesSearch = req.seriesName?.toLowerCase().includes(searchQuery.toLowerCase()) || String(req.volumeId).includes(searchQuery);
      const matchesStatus = statusFilter === "ALL" || req.status === statusFilter;
      const matchesUser = userFilter === "ALL" || req.userName === userFilter;
      return matchesSearch && matchesStatus && matchesUser;
    })
  }, [requests, searchQuery, statusFilter, userFilter])

  const sortedRequests = useMemo(() => {
    return [...filteredRequests].sort((a, b) => {
      let aValue = a[sortConfig.key];
      let bValue = b[sortConfig.key];
      
      if (typeof aValue === 'string') aValue = aValue.toLowerCase();
      if (typeof bValue === 'string') bValue = bValue.toLowerCase();

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    })
  }, [filteredRequests, sortConfig])

  const totalPages = Math.ceil(sortedRequests.length / pageSize) || 1;
  
  useEffect(() => { if (currentPage > totalPages) setCurrentPage(totalPages); }, [totalPages, currentPage])

  const paginatedRequests = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedRequests.slice(start, start + pageSize);
  }, [sortedRequests, currentPage, pageSize])

  const handleSort = (key: string) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  }

  const initiateDelete = (ids: string[]) => {
    setIdsToDelete(ids);
    setConfirmOpen(true);
  }

  const handleConfirmedDelete = async () => {
    if (idsToDelete.length === 0) return;
    setIsDeleting(true);
    try {
      const res = await fetch('/api/admin/requests', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(idsToDelete.length === 1 ? { id: idsToDelete[0] } : { ids: idsToDelete })
      });
      if (res.ok) {
        toast({ title: "Deleted", description: `Successfully removed ${idsToDelete.length} request(s).` });
        if (idsToDelete.length > 1) setSelectedIds(new Set());
        setConfirmOpen(false);
        fetchRequests();
      }
    } finally { setIsDeleting(false); }
  }

  const toggleAll = () => {
    if (selectedIds.size === paginatedRequests.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(paginatedRequests.map(r => r.id)));
  }

  // --- Details Fetcher ---
  const openDetails = async (req: any) => {
    setDetailsOpen(true);
    setLoadingDetails(true);
    try {
      const issueMatch = req.seriesName.match(/#(\d+)/);

      if (issueMatch) {
        const targetIssueNum = parseFloat(issueMatch[1]);
        const [volRes, issuesRes] = await Promise.all([
          fetch(`/api/issue-details?id=${req.volumeId}&type=volume`),
          fetch(`/api/series-issues?volumeId=${req.volumeId}`)
        ]);
        const volData = await volRes.json();
        const issuesData = await issuesRes.json();
        const specificIssue = issuesData.results?.find((i: any) => parseFloat(i.issueNumber) === targetIssueNum);

        setSelectedComicDetails({
          overrideName: req.seriesName,
          image: req.imageUrl || specificIssue?.image || volData.image, 
          description: specificIssue?.description || volData.description,
          publisher: volData.publisher,
          year: volData.year
        });
      } else {
        const res = await fetch(`/api/issue-details?id=${req.volumeId}&type=volume`);
        const data = await res.json();
        setSelectedComicDetails({ 
          ...data, 
          overrideName: req.seriesName,
          image: req.imageUrl || data.image 
        });
      }
    } catch (e) {
      toast({ title: "Error", description: "Failed to load comic details.", variant: "destructive" });
    } finally {
      setLoadingDetails(false);
    }
  }

  const getStatusColor = (status: string) => {
    if (['IMPORTED', 'COMPLETED'].includes(status)) return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800";
    if (status === 'DOWNLOADING') return "bg-primary/20 text-primary border-primary/30";
    if (status === 'PENDING_APPROVAL') return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800";
    if (status === 'UNRELEASED') return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800";
    return "bg-muted text-foreground border-border";
  }

  const SortIcon = ({ columnKey }: { columnKey: string }) => {
    if (sortConfig.key !== columnKey) return <ChevronsUpDown className="w-3 h-3 ml-1 opacity-50" />;
    return sortConfig.direction === 'asc' ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />;
  }

  const handleResizeStart = (e: React.MouseEvent, colKey: string) => {
    e.stopPropagation();
    setIsResizing(colKey);
    startXRef.current = e.clientX;
    startWidthRef.current = colWidths[colKey];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.max(50, startWidthRef.current + delta); 
      setColWidths(prev => ({ ...prev, [isResizing]: newWidth }));
    }
    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(null);
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
      }
    }
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
  }, [isResizing])

  const ResizeHandle = ({ colKey }: { colKey: string }) => (
    <div 
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize z-10 group-hover/th:bg-muted-foreground/30 hover:!bg-primary active:!bg-primary/80 transition-colors"
      onMouseDown={(e) => handleResizeStart(e, colKey)}
      onClick={(e) => e.stopPropagation()} 
    />
  )

  return (
    <div className="space-y-4 transition-colors duration-300">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Request Management</h2>
          <p className="text-sm text-muted-foreground">Manage, filter, and delete all user requests.</p>
        </div>
        
        {selectedIds.size > 0 && (
          <Button variant="destructive" onClick={() => initiateDelete(Array.from(selectedIds))} disabled={isDeleting} className="h-12 sm:h-10 font-bold w-full sm:w-auto animate-in fade-in zoom-in-95 shadow-lg">
            {isDeleting ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2" /> : <Trash2 className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />}
            Delete ({selectedIds.size})
          </Button>
        )}
      </div>

      <div className="flex flex-col lg:flex-row items-center gap-3 sm:gap-4 p-3 sm:p-4 bg-muted/50 border border-border rounded-lg transition-colors duration-300">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 sm:h-4 sm:w-4 text-muted-foreground" />
          <Input 
            placeholder="Search by series, title, or CV ID..." 
            className="pl-10 sm:pl-9 h-12 sm:h-10 bg-background border-border shadow-sm box-border"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4 w-full lg:w-auto shrink-0">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-12 sm:h-10 w-full sm:w-[220px] bg-background border-border shadow-sm box-border font-medium">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="ALL" className="focus:bg-primary/10 focus:text-primary">All Statuses</SelectItem>
              <SelectItem value="PENDING_APPROVAL" className="focus:bg-primary/10 focus:text-primary">Needs Approval</SelectItem>
              <SelectItem value="PENDING" className="focus:bg-primary/10 focus:text-primary">Pending Search</SelectItem>
              <SelectItem value="UNRELEASED" className="focus:bg-primary/10 focus:text-primary">Unreleased</SelectItem>
              <SelectItem value="DOWNLOADING" className="focus:bg-primary/10 focus:text-primary">Downloading</SelectItem>
              <SelectItem value="IMPORTED" className="focus:bg-primary/10 focus:text-primary">Imported</SelectItem>
              <SelectItem value="STALLED" className="focus:bg-primary/10 focus:text-primary">Stalled / Failed</SelectItem>
            </SelectContent>
          </Select>

          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger className="h-12 sm:h-10 w-full sm:w-[220px] bg-background border-border shadow-sm box-border font-medium">
              <SelectValue placeholder="User" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="ALL" className="focus:bg-primary/10 focus:text-primary">All Users</SelectItem>
              {uniqueUsers.map(u => <SelectItem key={u} value={u} className="focus:bg-primary/10 focus:text-primary">{u}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-hidden bg-background shadow-sm transition-colors duration-300">
        
        {/* --- DESKTOP TABLE VIEW (Hidden on Mobile) --- */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm text-left table-fixed min-w-[800px]">
            <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
              <tr>
                <th style={{ width: colWidths.checkbox }} className="px-4 py-3 text-center relative group/th">
                  <Checkbox checked={selectedIds.size === paginatedRequests.length && paginatedRequests.length > 0} onCheckedChange={toggleAll} />
                  <ResizeHandle colKey="checkbox" />
                </th>
                <th style={{ width: colWidths.seriesName }} className="relative group/th px-4 py-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('seriesName')}>
                  <div className="flex items-center">Series / Name <SortIcon columnKey="seriesName" /></div>
                  <ResizeHandle colKey="seriesName" />
                </th>
                <th style={{ width: colWidths.userName }} className="relative group/th px-4 py-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('userName')}>
                  <div className="flex items-center">User <SortIcon columnKey="userName" /></div>
                  <ResizeHandle colKey="userName" />
                </th>
                <th style={{ width: colWidths.status }} className="relative group/th px-4 py-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('status')}>
                  <div className="flex items-center">Status <SortIcon columnKey="status" /></div>
                  <ResizeHandle colKey="status" />
                </th>
                <th style={{ width: colWidths.createdAt }} className="relative group/th px-4 py-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('createdAt')}>
                  <div className="flex items-center">Requested <SortIcon columnKey="createdAt" /></div>
                  <ResizeHandle colKey="createdAt" />
                </th>
                <th style={{ width: colWidths.updatedAt }} className="relative group/th px-4 py-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('updatedAt')}>
                  <div className="flex items-center">Completed <SortIcon columnKey="updatedAt" /></div>
                  <ResizeHandle colKey="updatedAt" />
                </th>
                <th style={{ width: colWidths.actions }} className="px-4 py-3 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr><td colSpan={7} className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
              ) : paginatedRequests.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-10 text-muted-foreground italic">No requests found matching criteria.</td></tr>
              ) : (
                paginatedRequests.map((req) => {
                  const isExhausted = ['STALLED', 'FAILED', 'ERROR'].includes(req.status) && (req.retryCount >= 3);

                  return (
                  <tr key={req.id} className={`hover:bg-muted/50 transition-colors ${selectedIds.has(req.id) ? 'bg-primary/10' : ''}`}>
                    <td className="px-4 py-3 text-center">
                      <Checkbox checked={selectedIds.has(req.id)} onCheckedChange={(c) => {
                        const newSet = new Set(selectedIds);
                        c ? newSet.add(req.id) : newSet.delete(req.id);
                        setSelectedIds(newSet);
                      }} />
                    </td>
                    <td className="px-4 py-3 font-bold text-foreground truncate" title={req.seriesName}>
                      {req.seriesName}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground truncate">{req.userName}</td>
                    <td className="px-4 py-3">
                      <Badge className={`${getStatusColor(req.status)} text-[10px] uppercase font-bold px-2 py-0.5 truncate`}>
                        {req.status === 'PENDING_APPROVAL' ? 'Needs Approval' : req.status}
                      </Badge>
                      {isExhausted && (
                        <div className="text-[9px] text-red-500 font-bold mt-1.5 uppercase tracking-tighter flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Admin Intervention Required
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs truncate">
                      {new Date(req.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs truncate">
                      {['IMPORTED', 'COMPLETED'].includes(req.status) && req.updatedAt ? new Date(req.updatedAt).toLocaleDateString() : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted text-primary" onClick={() => openDetails(req)}>
                          <Info className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" asChild className="h-8 w-8 hover:bg-muted text-foreground">
                          <a href={`https://comicvine.gamespot.com/volume/4050-${req.volumeId}/`} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4" /></a>
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900/30 text-red-500" onClick={() => initiateDelete([req.id])}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
        </div>

        {/* --- MOBILE STACKED CARDS VIEW (Hidden on Desktop) --- */}
        <div className="md:hidden divide-y divide-border">
          {loading ? (
            <div className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>
          ) : paginatedRequests.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground italic">No requests found.</div>
          ) : (
            paginatedRequests.map(req => {
              const isExhausted = ['STALLED', 'FAILED', 'ERROR'].includes(req.status) && (req.retryCount >= 3);
              const isSelected = selectedIds.has(req.id);
              
              return (
                <div key={req.id} className={`p-4 space-y-4 transition-colors ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'}`}>
                  
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5">
                      <Checkbox 
                        className="w-5 h-5 rounded-sm"
                        checked={isSelected} 
                        onCheckedChange={(c) => {
                          const newSet = new Set(selectedIds);
                          c ? newSet.add(req.id) : newSet.delete(req.id);
                          setSelectedIds(newSet);
                        }} 
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-bold text-sm sm:text-base text-foreground line-clamp-2 leading-tight mb-1">{req.seriesName}</h4>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                        <Users className="w-3.5 h-3.5" /> <span className="font-medium truncate">{req.userName}</span>
                      </div>
                      <Badge className={`${getStatusColor(req.status)} text-[10px] uppercase font-bold px-2 py-0.5`}>
                        {req.status === 'PENDING_APPROVAL' ? 'Needs Approval' : req.status}
                      </Badge>
                      {isExhausted && (
                        <div className="text-[10px] text-red-500 font-bold mt-1.5 uppercase tracking-tighter flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" /> Admin Intervention Required
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-between items-center bg-muted p-2.5 rounded-md border border-border text-[11px] text-muted-foreground">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold uppercase tracking-wider text-[9px] opacity-70">Requested</span>
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3"/> {new Date(req.createdAt).toLocaleDateString()}</span>
                    </div>
                    {['IMPORTED', 'COMPLETED'].includes(req.status) && req.updatedAt && (
                      <div className="flex flex-col gap-0.5 items-end">
                        <span className="font-bold uppercase tracking-wider text-[9px] opacity-70">Completed</span>
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3"/> {new Date(req.updatedAt).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end gap-2 pt-1 border-t border-border">
                    <Button variant="outline" size="sm" className="h-10 w-10 sm:h-9 sm:w-9 text-primary border-border hover:bg-muted" onClick={() => openDetails(req)}>
                      <Info className="w-5 h-5 sm:w-4 sm:h-4" />
                    </Button>
                    <Button variant="outline" size="sm" asChild className="h-10 w-10 sm:h-9 sm:w-9 border-border hover:bg-muted text-foreground">
                      <a href={`https://comicvine.gamespot.com/volume/4050-${req.volumeId}/`} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-5 h-5 sm:w-4 sm:h-4" /></a>
                    </Button>
                    <Button variant="outline" size="sm" className="h-10 w-10 sm:h-9 sm:w-9 text-red-500 hover:bg-red-50 border-red-200 dark:border-red-900/50 dark:hover:bg-red-900/30" onClick={() => initiateDelete([req.id])}>
                      <Trash2 className="w-5 h-5 sm:w-4 sm:h-4" />
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* --- RESPONSIVE PAGINATION --- */}
        <div className="flex flex-col sm:flex-row items-center justify-between p-4 border-t border-border bg-muted/30 gap-4">
          <div className="flex items-center gap-2 w-full sm:w-auto justify-center sm:justify-start">
            <span className="text-sm text-muted-foreground">Rows per page:</span>
            <Select value={pageSize.toString()} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
              <SelectTrigger className="h-10 sm:h-8 w-[80px] sm:w-[70px] bg-background border-border font-medium"><SelectValue placeholder={pageSize} /></SelectTrigger>
              <SelectContent className="bg-popover border-border">
                <SelectItem value="10" className="focus:bg-primary/10 focus:text-primary">10</SelectItem>
                <SelectItem value="25" className="focus:bg-primary/10 focus:text-primary">25</SelectItem>
                <SelectItem value="50" className="focus:bg-primary/10 focus:text-primary">50</SelectItem>
                <SelectItem value="100" className="focus:bg-primary/10 focus:text-primary">100</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="flex items-center justify-center gap-1.5 w-full sm:w-auto">
            <Button variant="outline" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 bg-background border-border hover:bg-muted text-foreground" onClick={() => setCurrentPage(1)} disabled={currentPage === 1}><ChevronsLeft className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
            <Button variant="outline" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 bg-background border-border hover:bg-muted text-foreground" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
            <span className="text-sm font-bold px-3 sm:px-4 text-foreground">Pg {currentPage} of {totalPages}</span>
            <Button variant="outline" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 bg-background border-border hover:bg-muted text-foreground" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
            <Button variant="outline" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 bg-background border-border hover:bg-muted text-foreground" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages}><ChevronsRight className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
          </div>
        </div>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="sm:max-w-2xl w-[95%] bg-background border-border rounded-xl max-h-[90vh] overflow-y-auto">
          <DialogTitle className="sr-only">Comic Request Details</DialogTitle>
          <DialogDescription className="sr-only">View more information about the selected comic request.</DialogDescription>
          {loadingDetails ? (
            <div className="p-10 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
          ) : selectedComicDetails && (
            <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-6 p-2 sm:p-0">
               {/* FIX: ADDED sm:self-start TO STOP VERTICAL STRETCHING */}
               <div className="aspect-[2/3] w-3/4 sm:w-full mx-auto rounded-lg overflow-hidden border border-border shadow-md bg-muted sm:self-start">
                  <img src={selectedComicDetails.image} alt="Cover" className="w-full h-full object-cover" />
               </div>
               <div className="space-y-4">
                  <div className="text-center sm:text-left">
                    <h2 className="text-xl sm:text-2xl font-bold leading-tight text-foreground">{selectedComicDetails.overrideName}</h2>
                    <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 mt-2">
                        {selectedComicDetails.publisher && <span className="text-sm font-semibold text-primary">{selectedComicDetails.publisher}</span>}
                        <Badge variant="outline" className="border-border text-muted-foreground"><Calendar className="w-3 h-3 mr-1"/> {selectedComicDetails.year}</Badge>
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground bg-muted/50 p-4 rounded-lg border border-border min-h-[100px] max-h-[150px] overflow-y-auto">
                    {selectedComicDetails.description && selectedComicDetails.description !== "No description available." ? selectedComicDetails.description : <span className="italic">No synopsis available from ComicVine.</span>}
                  </div>
               </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Unified Deletion Confirmation (Bulk or Single) */}
      <ConfirmationDialog 
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirmedDelete}
        isLoading={isDeleting}
        title={idsToDelete.length > 1 ? "Delete Multiple Requests?" : "Delete Request?"}
        description={idsToDelete.length > 1 
          ? `You are about to permanently remove ${idsToDelete.length} request(s) from the database. This action cannot be undone.`
          : "Are you sure you want to permanently remove this request? This action cannot be undone."
        }
        confirmText={idsToDelete.length > 1 ? "Permanently Delete" : "Delete Request"}
      />
    </div>
  )
}