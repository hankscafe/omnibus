"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { 
  BookOpen, RefreshCw, Folder, Settings2, Loader2, Image as ImageIcon, ExternalLink, 
  Search, SortAsc, Filter, LayoutGrid, List, Check, Heart, ListPlus, Minus, Layers, Trash2,
  CheckSquare, Square, Eye, EyeOff, Library, Copy, MoreHorizontal, Activity, ArrowRightLeft, FileEdit
} from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { Switch } from "@/components/ui/switch"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

function LibrarySkeleton({ count = 24 }: { count?: number }) {
  return (
    <>
      <title>Omnibus - Library</title>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10">
        {[...Array(count)].map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="aspect-[2/3] rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
            <div className="h-3 w-3/4 bg-slate-200 dark:bg-slate-800 animate-pulse rounded" />
            <div className="h-2 w-1/2 bg-slate-200 dark:bg-slate-800 animate-pulse rounded" />
          </div>
        ))}
      </div>
    </>
  );
}

export default function LibraryPage() {
  if (typeof document !== 'undefined') document.title = "Omnibus - Library";

  const { data: session } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams() 
  const [series, setSeries] = useState<any[]>([])
  
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  
  const [editing, setEditing] = useState<any>(null)
  const [updating, setUpdating] = useState(false)
  const [copied, setCopied] = useState(false);
  
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [pageSize, setPageSize] = useState<number>(24);
  const [isInitialized, setIsInitialized] = useState(false);
  
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("") 
  const [searchType, setSearchType] = useState("ALL") 
  const [publisherFilter, setPublisherFilter] = useState("ALL")
  const [uniquePublishers, setUniquePublishers] = useState<string[]>([])
  const [libraryFilter, setLibraryFilter] = useState<'ALL' | 'COMICS' | 'MANGA'>('ALL') 
  const [sortOption, setSortOption] = useState("alpha_asc")
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false) 

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [refreshTarget, setRefreshTarget] = useState<{cvId: number, path: string} | null>(null)
  
  const [collections, setCollections] = useState<any[]>([])
  const [activeCollection, setActiveCollection] = useState("ALL")
  const [targetSeries, setTargetSeries] = useState<any>(null)
  const [newCollectionName, setNewCollectionName] = useState("")
  const [selectedCollectionId, setSelectedCollectionId] = useState("")
  const [manageListsOpen, setManageListsOpen] = useState(false)
  const [addingToList, setAddingToList] = useState(false)
  const [collectionToDelete, setCollectionToDelete] = useState<string | null>(null)

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedSeries, setSelectedSeries] = useState<Set<string>>(new Set());
  const [bulkDeleteModalOpen, setBulkDeleteModalOpen] = useState(false);
  const [bulkListModalOpen, setBulkListModalOpen] = useState(false);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkDeleteFiles, setBulkDeleteFiles] = useState(false);

  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renamePattern, setRenamePattern] = useState("{Series} ({Year}) - #{Issue}");

  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  const { toast } = useToast()
  const isAdmin = session?.user?.role === 'ADMIN'

  useEffect(() => {
    const savedView = localStorage.getItem('omnibus-library-view') as 'grid' | 'list'
    if (savedView === 'grid' || savedView === 'list') setViewMode(savedView)
    const savedSize = localStorage.getItem('omnibus-library-pagesize')
    if (savedSize) setPageSize(parseInt(savedSize))
    setIsInitialized(true)
  }, [])

  useEffect(() => {
      const timer = setTimeout(() => setDebouncedSearch(searchQuery), 500);
      return () => clearTimeout(timer);
  }, [searchQuery]);

  const toggleViewMode = (mode: 'grid' | 'list') => {
      setViewMode(mode)
      localStorage.setItem('omnibus-library-view', mode)
  }

  const handlePageSizeChange = (val: string) => {
      const newSize = parseInt(val);
      setPageSize(newSize);
      setPage(1);
      localStorage.setItem('omnibus-library-pagesize', val);
  }

  const handleNavigate = (e: React.MouseEvent, path: string, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      setNavigatingTo(id);
      router.push(`/library/series?path=${encodeURIComponent(path)}`);
      setTimeout(() => setNavigatingTo(null), 2000); 
  }

  const fetchCollections = useCallback(async () => {
    try {
      const res = await fetch('/api/library/collections');
      if (res.ok) setCollections(await res.json());
    } catch (e) { console.error(e); }
  }, []);

  const fetchLibraryData = useCallback(async (pageNum = 1, append = false, forceRefresh = false, currentLimit = 24) => {
    if (forceRefresh) setIsRefreshing(true);
    else if (pageNum === 1) setLoading(true);
    else setLoadingMore(true);

    try {
        const params = new URLSearchParams({
            page: pageNum.toString(),
            limit: currentLimit.toString(),
            ...(forceRefresh && { refresh: 'true' }),
            ...(debouncedSearch.trim() && { q: debouncedSearch.trim(), type: searchType }),
            ...(libraryFilter !== 'ALL' && { library: libraryFilter }),
            ...(publisherFilter !== 'ALL' && { publisher: publisherFilter }),
            ...(sortOption && { sort: sortOption }),
            ...(showFavoritesOnly && { favorites: 'true' }),
            ...(activeCollection !== 'ALL' && { collection: activeCollection })
        });

        const res = await fetch(`/api/library?${params.toString()}`, { cache: forceRefresh ? 'no-store' : 'default' })
        const data = await res.json()
        
        if (!res.ok && data.error) {
            toast({ title: "Scan Aborted", description: data.error, variant: "destructive" });
            return;
        }

        if (data.series) {
            setSeries(prev => {
                if (!append) return data.series;
                
                // PERFECT FIX: Deduplication Lock. 
                // Prevents React from ever throwing "two children with the same key" errors!
                const existingIds = new Set(prev.map(s => s.id || s.path));
                const newItems = data.series.filter((s: any) => !existingIds.has(s.id || s.path));
                
                return [...prev, ...newItems];
            });
            setHasMore(data.hasMore);
        }
        if (data.publishers) {
            setUniquePublishers(data.publishers);
        }
    } catch (e) {} finally { setLoading(false); setLoadingMore(false); setIsRefreshing(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, searchType, libraryFilter, publisherFilter, sortOption, showFavoritesOnly, activeCollection]);

  const refetchTrigger = searchParams.get('refetch');

  useEffect(() => { 
      if (isInitialized) { 
          const forceRefresh = !!refetchTrigger;
          setPage(1); 
          fetchLibraryData(1, false, forceRefresh, pageSize); 
          fetchCollections(); 

          if (forceRefresh) {
              const newUrl = new URL(window.location.href);
              newUrl.searchParams.delete('refetch');
              window.history.replaceState({}, '', newUrl.toString());
          }
      }
  }, [debouncedSearch, searchType, libraryFilter, publisherFilter, sortOption, showFavoritesOnly, activeCollection, pageSize, isInitialized, refetchTrigger, fetchLibraryData, fetchCollections])

  const handleRefresh = () => {
      setPage(1);
      fetchLibraryData(1, false, true, pageSize);
      toast({ title: "Scanning Disk", description: "Checking folders for new comics..." });
  }

  // --- BLAZING FAST INFINITE SCROLL (Fixed for small arrays) ---
  const observer = useRef<IntersectionObserver | null>(null);

  const lastElementRef = useCallback((node: HTMLDivElement | null) => {
      // Disconnect if we are actively fetching
      if (loading || loadingMore) return; 
      
      if (observer.current) observer.current.disconnect();
      
      observer.current = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting && hasMore) {
              setPage(prevPage => {
                  const nextPage = prevPage + 1;
                  fetchLibraryData(nextPage, true, false, pageSize);
                  return nextPage;
              });
          }
      }, { rootMargin: "400px" }); 
      
      if (node) observer.current.observe(node);
  }, [hasMore, fetchLibraryData, pageSize, loading, loadingMore]); 
  // Dependency array specifically includes loading states, so it re-evaluates visibility the moment a fetch finishes!

  const toggleFavorite = async (seriesId: string, currentStatus: boolean) => {
      if (!seriesId) return;
      setSeries(prev => prev.map(s => s.id === seriesId ? { ...s, isFavorite: !currentStatus } : s));
      try { await fetch('/api/library/favorite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesId }) }); } catch (e) { }
  };

  const submitAddToCollection = async () => {
      if (!targetSeries) return;
      setAddingToList(true);
      try {
          let colId = selectedCollectionId;
          if (newCollectionName.trim() && !selectedCollectionId) {
              const res = await fetch('/api/library/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCollectionName.trim() }) });
              const data = await res.json();
              if (data.collection) colId = data.collection.id;
          }
          if (!colId) throw new Error("No collection selected");
          const res2 = await fetch('/api/library/collections/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId: colId, seriesId: targetSeries.id, action: 'add' }) });
          if (res2.ok) {
              toast({ title: "Success", description: "Series added to list." });
              setTargetSeries(null); setNewCollectionName(""); setSelectedCollectionId(""); fetchCollections(); 
          }
      } catch (e) { toast({ variant: "destructive", title: "Error", description: "Could not add to list." }); } finally { setAddingToList(false); }
  }

  const submitBulkAddToCollection = async () => {
      setAddingToList(true);
      try {
          let colId = selectedCollectionId;
          if (newCollectionName.trim() && !selectedCollectionId) {
              const res = await fetch('/api/library/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newCollectionName.trim() }) });
              const data = await res.json();
              if (data.collection) colId = data.collection.id;
          }
          if (!colId) throw new Error("No collection selected");
          
          const res2 = await fetch('/api/library/collections/items', { 
              method: 'POST', 
              headers: { 'Content-Type': 'application/json' }, 
              body: JSON.stringify({ collectionId: colId, seriesIds: Array.from(selectedSeries), action: 'add' }) 
          });
          
          if (res2.ok) {
              toast({ title: "Mass Tagging Complete", description: `Added ${selectedSeries.size} series to your list.` });
              setBulkListModalOpen(false); setNewCollectionName(""); setSelectedCollectionId("");
              setSelectedSeries(new Set()); setIsSelectionMode(false);
              fetchCollections(); 
          }
      } catch (e) { toast({ variant: "destructive", title: "Error", description: "Could not add to list." }); } finally { setAddingToList(false); }
  }

  const handleRemoveFromCollection = async (seriesId: string) => {
      try {
          const res = await fetch('/api/library/collections/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId: activeCollection, seriesId, action: 'remove' }) });
          if (res.ok) { toast({ title: "Removed", description: "Series removed from list." }); fetchCollections(); fetchLibraryData(1, false, true, pageSize); }
      } catch (e) { }
  }

  const handleDeleteCollection = async () => {
      if (!collectionToDelete) return;
      try {
          const res = await fetch(`/api/library/collections?id=${collectionToDelete}`, { method: 'DELETE' });
          if (res.ok) {
              toast({ title: "List Deleted" });
              if (activeCollection === collectionToDelete) setActiveCollection("ALL");
              fetchCollections();
          } else {
              toast({ title: "Error", description: "Could not delete list.", variant: "destructive" });
          }
      } catch (e) { 
          toast({ title: "Error", variant: "destructive" }); 
      } finally {
          setCollectionToDelete(null);
      }
  }

  const copyToClipboard = () => {
    if (editing?.path) {
      navigator.clipboard.writeText(editing.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Path Copied" });
    }
  };

  const handleUpdateMetadata = async () => {
    if (!editing) return
    setUpdating(true)
    try {
      const res = await fetch('/api/library/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            currentPath: editing.path, name: editing.name, year: editing.year, publisher: editing.publisher, 
            cvId: editing.cvId ? parseInt(editing.cvId) : null, monitored: editing.monitored, isManga: editing.isManga
        })
      });
      if (res.ok) {
        toast({ title: "Success!", description: "Series info updated." });
        setEditing(null);
        fetchLibraryData(1, false, true, pageSize);
      } else {
        const err = await res.json(); toast({ title: "Update Failed", description: err.error || "Unknown error", variant: "destructive" });
      }
    } catch (e: any) { toast({ title: "Error", description: e.message, variant: "destructive" }); } finally { setUpdating(false) }
  }

  const initiateRefreshMetadata = (cvId: number, folderPath: string) => {
    if (!cvId) { toast({ title: "Missing ID", description: "This folder isn't linked to a ComicVine ID. Use 'Edit Info' to add one." }); return; }
    setRefreshTarget({ cvId, path: folderPath }); setConfirmOpen(true);
  }

  const handleConfirmedRefresh = async () => {
    if (!refreshTarget) return;
    setLoading(true); setConfirmOpen(false);
    try {
      const res = await fetch('/api/library/refresh-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cvId: refreshTarget.cvId, folderPath: refreshTarget.path }) });
      if (res.ok) { toast({ title: "Success", description: "Metadata and cover art refreshed!" }); fetchLibraryData(1, false, true, pageSize); }
    } finally { setLoading(false); setRefreshTarget(null); }
  }

  const toggleSeriesSelection = (id: string) => {
      if (!id) return;
      setSelectedSeries(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
      });
  }

  const toggleSelectAll = () => {
      if (selectedSeries.size === series.length && series.length > 0) setSelectedSeries(new Set());
      else setSelectedSeries(new Set(series.map(s => s.id).filter(id => !!id)));
  }

  const handleBulkProgress = async (status: 'READ' | 'UNREAD') => {
    setIsBulkProcessing(true);
    try {
        const res = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesIds: Array.from(selectedSeries), status, action: 'bulk-progress' }) });
        if (res.ok) {
            const isRead = status === 'READ';
            toast({ title: "Bulk Update Success", description: `Marked ${selectedSeries.size} series as ${isRead ? 'read' : 'unread'}.` });
            setSeries(prev => prev.map(s => selectedSeries.has(s.id) ? { ...s, unreadCount: isRead ? 0 : s.count, progressPercentage: isRead ? 100 : 0 } : s));
            setSelectedSeries(new Set()); setIsSelectionMode(false);
        }
    } catch (e) { toast({ title: "Update Failed", variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const handleBulkAdvanced = async (action: string, status: string) => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesIds: Array.from(selectedSeries), action, status }) });
          if (res.ok) {
              toast({ title: "Bulk Update Complete" }); 
              
              if (action === 'bulk-remove-list') {
                  fetchCollections();
              }
              
              fetchLibraryData(1, false, true, pageSize); 
              setSelectedSeries(new Set()); 
              setIsSelectionMode(false);
          } else {
              const data = await res.json(); toast({ title: "Update Failed", description: data.error, variant: "destructive" });
          }
      } catch (e) { toast({ title: "Error", variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const handleBulkRefresh = async () => {
      const seriesList = series.filter(s => selectedSeries.has(s.id));
      setIsBulkProcessing(true);
      toast({ title: "Starting Metadata Refresh", description: `Queued ${seriesList.length} series. Please keep this page open.` });
      
      let successCount = 0;
      for (let i = 0; i < seriesList.length; i++) {
          const s = seriesList[i];
          if (!s.cvId) continue; 
          try {
              await fetch('/api/library/refresh-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cvId: s.cvId, folderPath: s.path }) });
              successCount++;
          } catch(e) {}
          if (i < seriesList.length - 1) await new Promise(r => setTimeout(r, 2000));
      }
      
      toast({ title: "Refresh Complete", description: `Successfully refreshed ${successCount} series.` });
      fetchLibraryData(1, false, true, pageSize); setIsBulkProcessing(false); setSelectedSeries(new Set()); setIsSelectionMode(false);
  }

  const handleBulkRename = async () => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seriesIds: Array.from(selectedSeries), pattern: renamePattern })
          });
          if (res.ok) {
              const data = await res.json();
              toast({ title: "Renaming Complete", description: `Successfully renamed ${data.filesRenamed} files across ${data.foldersRenamed > 0 ? data.foldersRenamed : 'selected'} folders.` });
              setRenameModalOpen(false); setSelectedSeries(new Set()); setIsSelectionMode(false); fetchLibraryData(1, false, true, pageSize);
          } else {
              const data = await res.json(); toast({ title: "Renaming Failed", description: data.error, variant: "destructive" });
          }
      } catch (e) { toast({ title: "Error", variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const handleBulkDelete = async () => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library/series', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesIds: Array.from(selectedSeries), deleteFiles: bulkDeleteFiles }) });
          if (!res.ok) throw new Error("Failed to delete selected series.");
          toast({ title: "Series Deleted", description: `Successfully removed ${selectedSeries.size} series.` });
          setSeries(prev => prev.filter(s => !selectedSeries.has(s.id)));
          setSelectedSeries(new Set()); setIsSelectionMode(false); setBulkDeleteModalOpen(false);
      } catch (e: any) { toast({ title: "Delete Failed", description: e.message, variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  return (
    <div className="container mx-auto py-10 px-6 relative">
      <title>Omnibus - Library</title>
      
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <h1 className="text-3xl font-bold flex items-center gap-2">Library</h1>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 w-full sm:w-auto justify-between sm:justify-end">
            <div className="flex bg-slate-200 dark:bg-slate-900/80 p-1 rounded-md shrink-0 shadow-inner border dark:border-slate-800">
                <Button variant={libraryFilter === 'ALL' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'ALL' ? 'shadow-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'text-muted-foreground'}`} onClick={() => setLibraryFilter('ALL')}>All</Button>
                <Button variant={libraryFilter === 'COMICS' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'COMICS' ? 'shadow-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'text-muted-foreground'}`} onClick={() => setLibraryFilter('COMICS')}>Comics</Button>
                <Button variant={libraryFilter === 'MANGA' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'MANGA' ? 'shadow-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'text-muted-foreground'}`} onClick={() => setLibraryFilter('MANGA')}>Manga</Button>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                <Button variant={isSelectionMode ? "secondary" : "outline"} size="sm" onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedSeries(new Set()); }} className={`h-10 sm:h-9 ${isSelectionMode ? "bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-400 border-blue-300 dark:border-blue-800" : ""}`}>
                    <CheckSquare className="w-4 h-4 mr-2" /> {isSelectionMode ? "Cancel Select" : "Select"}
                </Button>
                <Button onClick={handleRefresh} disabled={loading || isRefreshing} variant="outline" size="sm" className="h-10 sm:h-9">
                {isRefreshing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />} Refresh
                </Button>
            </div>
        </div>
      </div>

      {/* --- ADVANCED TOOLBAR --- */}
      <div className="flex flex-col xl:flex-row gap-4 mb-8 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-lg border dark:border-slate-800">
          <div className="relative flex flex-col sm:flex-row flex-1 min-w-[200px] gap-2">
              <Select value={searchType} onValueChange={setSearchType}>
                  <SelectTrigger className="w-full sm:w-[140px] bg-white dark:bg-slate-950 shadow-sm dark:border-slate-800 shrink-0 h-10 sm:h-9">
                      <SelectValue placeholder="Search In" />
                  </SelectTrigger>
                  <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                      <SelectItem value="ALL">Everything</SelectItem>
                      <SelectItem value="TITLE">Title / Pub</SelectItem>
                      <SelectItem value="WRITER">Writer</SelectItem>
                      <SelectItem value="ARTIST">Artist</SelectItem>
                      <SelectItem value="CHARACTER">Character</SelectItem>
                  </SelectContent>
              </Select>
              <div className="relative flex-1 w-full">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder={`Search ${searchType === 'ALL' ? 'series, creators, or characters' : searchType.toLowerCase()}...`} className="pl-9 h-10 sm:h-9 bg-white dark:bg-slate-950 shadow-sm dark:border-slate-800 w-full" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
              </div>
          </div>
          <div className="flex flex-wrap gap-3 w-full xl:w-auto items-center">
              <div className="flex items-center gap-1 w-full sm:w-auto shrink-0">
                  <Select value={activeCollection} onValueChange={setActiveCollection}>
                      <SelectTrigger className={`w-full sm:w-[170px] h-10 sm:h-9 shadow-sm ${activeCollection !== "ALL" ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-900/50 font-bold" : "bg-white dark:bg-slate-950 dark:border-slate-800"}`}>
                          <div className="flex items-center gap-2 truncate"><Layers className="w-3 h-3 shrink-0"/> <SelectValue placeholder="Reading Lists" /></div>
                      </SelectTrigger>
                      <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                          <SelectItem value="ALL">All Comics</SelectItem>
                          {collections.length > 0 && <div className="border-t dark:border-slate-800 my-1" />}
                          {collections.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      </SelectContent>
                  </Select>
                  <Button variant="outline" size="icon" className="h-10 w-10 sm:h-9 sm:w-9 shrink-0 bg-white dark:bg-slate-950 dark:border-slate-800 shadow-sm" onClick={() => setManageListsOpen(true)} title="Manage Lists"><Settings2 className="w-4 h-4 text-muted-foreground" /></Button>
              </div>
              <Button variant={showFavoritesOnly ? "default" : "outline"} className={`flex-1 sm:flex-none h-10 sm:h-9 font-bold shadow-sm ${showFavoritesOnly ? 'bg-pink-600 hover:bg-pink-700 text-white border-0' : 'bg-white dark:bg-slate-950 dark:border-slate-800 text-slate-500 hover:text-pink-600'}`} onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}><Heart className={`w-4 h-4 ${showFavoritesOnly ? 'fill-current' : ''} sm:mr-2`} /><span className="hidden sm:inline-block">Favorites</span></Button>
              
              <Select value={publisherFilter} onValueChange={setPublisherFilter}>
                  <SelectTrigger className="flex-1 sm:w-[150px] sm:flex-none h-10 sm:h-9 bg-white dark:bg-slate-950 shadow-sm dark:border-slate-800">
                      <div className="flex items-center gap-2 truncate"><Filter className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Publisher" /></div>
                  </SelectTrigger>
                  <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                      <SelectItem value="ALL">All Publishers</SelectItem>
                      {uniquePublishers.map(pub => (<SelectItem key={pub} value={pub}>{pub}</SelectItem>))}
                  </SelectContent>
              </Select>
              
              <Select value={sortOption} onValueChange={setSortOption}>
                  <SelectTrigger className="flex-1 sm:w-[150px] sm:flex-none h-10 sm:h-9 bg-white dark:bg-slate-950 shadow-sm dark:border-slate-800">
                      <div className="flex items-center gap-2 truncate"><SortAsc className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Sort By" /></div>
                  </SelectTrigger>
                  <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                      <SelectItem value="alpha_asc">Title (A-Z)</SelectItem>
                      <SelectItem value="alpha_desc">Title (Z-A)</SelectItem>
                      <SelectItem value="year_desc">Release Year (Newest)</SelectItem>
                      <SelectItem value="year_asc">Release Year (Oldest)</SelectItem>
                      <SelectItem value="count_desc">Issue Count (High)</SelectItem>
                  </SelectContent>
              </Select>

              <Select value={pageSize.toString()} onValueChange={handlePageSizeChange}>
                  <SelectTrigger className="flex-1 sm:w-[130px] sm:flex-none h-10 sm:h-9 bg-white dark:bg-slate-950 shadow-sm dark:border-slate-800">
                      <div className="flex items-center gap-2 truncate"><List className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Show 24" /></div>
                  </SelectTrigger>
                  <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                      <SelectItem value="16">Show 16</SelectItem>
                      <SelectItem value="24">Show 24</SelectItem>
                      <SelectItem value="32">Show 32</SelectItem>
                      <SelectItem value="48">Show 48</SelectItem>
                      <SelectItem value="64">Show 64</SelectItem>
                  </SelectContent>
              </Select>
              <div className="flex items-center gap-1 border dark:border-slate-800 rounded-md p-1 bg-white dark:bg-slate-950 shadow-sm shrink-0"><Button variant={viewMode === 'grid' ? "secondary" : "ghost"} size="icon" className="h-8 w-8 sm:h-7 sm:w-7" onClick={() => toggleViewMode('grid')}><LayoutGrid className="w-4 h-4" /></Button><Button variant={viewMode === 'list' ? "secondary" : "ghost"} size="icon" className="h-8 w-8 sm:h-7 sm:w-7" onClick={() => toggleViewMode('list')}><List className="w-4 h-4" /></Button></div>
          </div>
      </div>

      {loading ? (
        <LibrarySkeleton count={pageSize} />
      ) : series.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground border-2 border-dashed rounded-lg dark:border-slate-800 bg-slate-50 dark:bg-slate-900/10">
          {activeCollection !== "ALL" ? (<><Layers className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>This reading list is currently empty.</p></>) : (<><Folder className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No comics found matching your criteria.</p></>)}
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10">
          {series.map((item: any) => {
              const unread = item.unreadCount !== undefined ? item.unreadCount : item.count;
              const isCompleted = unread === 0 && item.count > 0;
              const progress = item.progressPercentage || 0;
              const isSelected = selectedSeries.has(item.id);
              const navId = item.id || item.path;
              return (
                <div key={item.id || item.path} className="group flex flex-col space-y-2 relative" onClick={(e) => { 
                    if (isSelectionMode && item.id) toggleSeriesSelection(item.id); 
                }}>
                  <Card className={`aspect-[2/3] overflow-hidden shadow-sm transition-all p-0 relative flex flex-col ${isSelectionMode ? (isSelected ? 'border-4 border-blue-500 scale-95' : 'border-2 border-slate-200 dark:border-slate-800 cursor-pointer') : 'border-slate-200 dark:border-slate-800 group-hover:shadow-md cursor-pointer'}`}>
                      {isSelectionMode && item.id && (<div className="absolute top-2 left-2 z-40 bg-black/50 backdrop-blur-sm rounded p-1 pointer-events-none">{isSelected ? <CheckSquare className="w-6 h-6 text-blue-400" /> : <Square className="w-6 h-6 text-white/80" />}</div>)}
                      <div 
                          className="relative flex-1 bg-slate-100 dark:bg-slate-900 flex items-center justify-center overflow-hidden"
                          onClick={(e) => { if (!isSelectionMode) handleNavigate(e, item.path, navId); }}
                      >
                          <ImageIcon className="w-8 h-8 text-slate-300 dark:text-slate-600 absolute z-0" />
                          {item.cover && (
                              <img 
                                src={item.cover} 
                                alt="Cover" 
                                loading="lazy" 
                                className={`object-cover w-full h-full relative z-10 transition-opacity ${isCompleted ? 'opacity-60' : ''}`} 
                                onError={(e) => { e.currentTarget.style.display = 'none'; }} 
                              />
                          )}
                          {!isSelectionMode && (
                              <div className="absolute top-1.5 left-1.5 flex flex-col gap-1 items-start z-30 pointer-events-none">
                                  {isCompleted ? (
                                      <Badge className="bg-green-600 hover:bg-green-600 text-white border-0 shadow-sm px-1.5 h-4 flex items-center gap-1 text-[9px] font-black uppercase tracking-wider"><Check className="w-2.5 h-2.5" /> Read</Badge>
                                  ) : unread > 0 ? (
                                      <Badge className="text-[9px] px-1.5 h-4 bg-blue-600 hover:bg-blue-600 border-0 text-white font-bold shadow-sm uppercase tracking-wider">{unread === item.count ? 'Unread' : `${unread} Left`}</Badge>
                                  ) : null}
                                  <Badge className="text-[9px] px-1.5 h-4 bg-black/70 hover:bg-black/70 border-0 text-white font-mono shadow-sm backdrop-blur-sm" title="Total Issues">{item.count} {item.count === 1 ? 'Issue' : 'Issues'}</Badge>
                              </div>
                          )}
                          {/* Heart always visible slightly on mobile, fully visible on hover */}
                          {!isSelectionMode && (
                              <div className="absolute top-1.5 right-1.5 z-30">
                                  <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.id, item.isFavorite); }} className={`h-8 w-8 sm:h-6 sm:w-6 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center transition-all ${item.isFavorite ? 'text-pink-500 opacity-100' : 'text-white/70 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:text-pink-400'}`}>
                                      <Heart className={`w-4 h-4 sm:w-3.5 sm:h-3.5 ${item.isFavorite ? 'fill-current' : ''}`} />
                                  </button>
                              </div>
                          )}
                          {progress > 0 && !isCompleted && (<div className="absolute bottom-0 left-0 right-0 h-2.5 bg-black/80 z-10 border-t border-black/40"><div className="h-full bg-blue-500 transition-all duration-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]" style={{ width: `${progress}%` }} /></div>)}
                      </div>

                      {/* Hover Overlay with chunky mobile buttons */}
                      <div className={`absolute inset-0 bg-black/80 transition-opacity flex flex-col items-center justify-center gap-1.5 p-3 z-20 ${isSelectionMode ? 'hidden' : 'opacity-0 sm:group-hover:opacity-100'}`}>
                        <Button 
                            variant="default" 
                            size="sm" 
                            className="h-10 sm:h-8 w-full shadow-lg text-xs sm:text-[10px] font-bold bg-purple-600 hover:bg-purple-700 text-white border-0" 
                            onClick={(e) => handleNavigate(e, item.path, navId)}
                        >
                            {navigatingTo === navId ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <BookOpen className="w-3 h-3 mr-2" />} 
                            {navigatingTo === navId ? "Loading..." : "Read Series"}
                        </Button>
                        <div className="flex gap-2 w-full">
                            <Button variant="secondary" size="sm" className="h-10 sm:h-8 flex-1 shadow-lg text-xs sm:text-[10px] font-bold" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTargetSeries(item); }}><ListPlus className="w-3 h-3" /> List</Button>
                            {isAdmin && (<Button variant="secondary" size="sm" className="h-10 sm:h-8 flex-1 shadow-lg text-xs sm:text-[10px] font-bold" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(item); }}><Settings2 className="w-3 h-3" /> Edit</Button>)}
                        </div>
                        {isAdmin && (<Button variant="default" size="sm" className="h-10 sm:h-8 w-full shadow-lg gap-2 text-xs sm:text-[10px] font-bold bg-blue-600 hover:bg-blue-700 text-white border-0" onClick={(e) => { e.preventDefault(); e.stopPropagation(); initiateRefreshMetadata(item.cvId, item.path); }}><RefreshCw className="w-3 h-3" /> Fetch Cover</Button>)}
                        {activeCollection !== "ALL" && (<Button variant="destructive" size="sm" className="h-10 sm:h-8 w-full shadow-lg gap-2 text-xs sm:text-[10px] font-bold" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveFromCollection(item.id); }}><Minus className="w-3 h-3" /> Remove</Button>)}
                      </div>
                  </Card>
                  <div className="px-0.5" onClick={(e) => { if (!isSelectionMode) handleNavigate(e, item.path, navId); }}>
                      <div className="flex items-start justify-between gap-1 cursor-pointer hover:underline">
                          <h3 className={`text-[12px] sm:text-[11px] font-bold truncate leading-tight ${isCompleted ? 'text-muted-foreground' : 'dark:text-slate-200'}`} title={item.name}>{item.name}</h3>
                      </div>
                      <p className="text-[10px] sm:text-[9px] text-muted-foreground mt-0.5 truncate">{item.publisher || 'Unknown'} • {item.year || '????'}</p>
                  </div>
                </div>
              )
          })}
        </div>
      ) : (
        <div className="border dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-950 pb-0 mb-10">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-slate-50 dark:bg-slate-900/50 border-b dark:border-slate-800">
                <tr>{isSelectionMode && <th className="w-12 px-4 py-3 text-center">Select</th>}<th className="w-16 px-4 py-3 text-center">Cover</th><th className="px-4 py-3">Series Name</th><th className="px-4 py-3 hidden md:table-cell">Publisher</th><th className="px-4 py-3 hidden sm:table-cell text-center">Year</th><th className="px-4 py-3 text-center">Issues</th>{!isSelectionMode && <th className="px-4 py-3 text-right">Actions</th>}</tr>
              </thead>
              <tbody className="divide-y dark:divide-slate-800">
                {series.map((item: any) => {
                  const unread = item.unreadCount !== undefined ? item.unreadCount : item.count;
                  const isCompleted = unread === 0 && item.count > 0;
                  const isSelected = selectedSeries.has(item.id);
                  const navId = item.id || item.path;
                  return (
                    <tr key={item.id || item.path} className={`transition-colors group ${isSelectionMode ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-900 ' + (isSelected ? 'bg-blue-50/50 dark:bg-blue-900/20' : '') : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'}`} onClick={() => isSelectionMode && item.id && toggleSeriesSelection(item.id)}>
                        {isSelectionMode && (<td className="px-4 py-3 text-center">{isSelected ? <CheckSquare className="w-6 h-6 text-blue-500 mx-auto" /> : <Square className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto" />}</td>)}
                        <td className="px-4 py-2 cursor-pointer" onClick={(e) => { if(!isSelectionMode) handleNavigate(e, item.path, navId); }}>
                            <div className="w-10 h-14 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden flex items-center justify-center shrink-0 border dark:border-slate-700 relative">
                                <ImageIcon className="w-4 h-4 text-slate-300 dark:text-slate-600 absolute z-0" />
                                {item.cover && (
                                    <img 
                                      src={item.cover} 
                                      alt="Cover" 
                                      loading="lazy" 
                                      className={`w-full h-full object-cover relative z-10 transition-opacity ${isCompleted ? 'opacity-60' : ''}`} 
                                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                    />
                                )}
                                {isCompleted && (<div className="absolute inset-0 flex items-center justify-center bg-green-500/20 z-20"><Check className="w-4 h-4 text-green-500 font-bold"/></div>)}
                            </div>
                        </td>
                        <td className={`px-4 py-3 font-bold ${isCompleted ? 'text-muted-foreground' : 'text-slate-900 dark:text-slate-100'}`}>
                            <div className="flex items-center gap-2">
                                {isSelectionMode ? (<span>{item.name}</span>) : (
                                    <button 
                                        onClick={(e) => handleNavigate(e, item.path, navId)} 
                                        className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left font-bold flex items-center gap-2"
                                    >
                                        {item.name}
                                        {navigatingTo === navId && <Loader2 className="w-3 h-3 animate-spin text-blue-500" />}
                                    </button>
                                )}
                                {!isSelectionMode && (<button onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.id, item.isFavorite); }} className={`transition-colors focus:outline-none p-2 -m-2 ${item.isFavorite ? 'text-pink-500' : 'text-slate-300 hover:text-pink-400 opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}`}><Heart className={`w-4 h-4 sm:w-3.5 sm:h-3.5 ${item.isFavorite ? 'fill-current' : ''}`} /></button>)}
                            </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{item.publisher || 'Unknown'}</td>
                        <td className="px-4 py-3 text-center hidden sm:table-cell">{item.year || '????'}</td>
                        <td className="px-4 py-3 text-center">
                            <div className="flex items-center justify-center gap-2">
                                <Badge variant="secondary" className="font-mono" title="Total Issues">{item.count}</Badge>
                                {unread > 0 && !isCompleted && (
                                    <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-0 font-bold uppercase tracking-wider text-[10px]">{unread === item.count ? 'Unread' : `${unread} Left`}</Badge>
                                )}
                            </div>
                        </td>
                        {!isSelectionMode && (
                            <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                    <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8" title="Add to List" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTargetSeries(item); }}> <ListPlus className="w-5 h-5 sm:w-4 sm:h-4" /> </Button> 
                                    {activeCollection !== "ALL" && (<Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="Remove from List" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveFromCollection(item.id); }}> <Minus className="w-5 h-5 sm:w-4 sm:h-4" /> </Button>)} 
                                    <Button variant="ghost" size="icon" className="hidden sm:inline-flex h-8 w-8" title="Edit Metadata" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(item); }}> <Settings2 className="w-4 h-4 text-muted-foreground" /> </Button>
                                    <Button 
                                        variant="ghost" 
                                        size="icon" 
                                        className="h-10 w-10 sm:h-8 sm:w-8"
                                        title="Read Series"
                                        onClick={(e) => handleNavigate(e, item.path, navId)}
                                    > 
                                        {navigatingTo === navId ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin" /> : <BookOpen className="w-5 h-5 sm:w-4 sm:h-4" />}
                                    </Button>
                                </div>
                            </td>
                        )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- FIXED: INFINITE SCROLL TRIGGER COMPONENT --- */}
      {hasMore && !isSelectionMode && (
          <div ref={lastElementRef} className="flex justify-center pt-8 pb-12 w-full">
              {loadingMore ? (
                  <div className="flex items-center text-muted-foreground font-medium bg-slate-50 dark:bg-slate-900/50 px-4 py-2 rounded-full border dark:border-slate-800 shadow-sm">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading more...
                  </div>
              ) : (
                  <div className="h-10 w-full" /> 
              )}
          </div>
      )}

      {/* FLOATING ACTION BAR */}
      {isSelectionMode && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-4 sm:px-6 py-3 rounded-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] dark:shadow-[0_10px_40px_-10px_rgba(0,0,0,0.7)] flex items-center gap-3 sm:gap-4 z-50 animate-in slide-in-from-bottom-8 border border-slate-200 dark:border-slate-800 w-[95%] sm:w-auto overflow-x-auto">
              <Button variant="ghost" size="sm" className="h-10 sm:h-8 shrink-0 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 font-medium" onClick={toggleSelectAll}>
                  {selectedSeries.size === series.length && series.length > 0 ? "Deselect All" : "Select All"}
              </Button>
              <div className="h-5 w-px bg-slate-200 dark:bg-slate-700 shrink-0" />
              <span className="font-black whitespace-nowrap min-w-[60px] sm:min-w-[100px] text-center text-sm sm:text-base shrink-0">{selectedSeries.size} Selected</span>
              
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedSeries.size > 0 ? 'text-slate-600 hover:bg-slate-100' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'}`} disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => handleBulkProgress('UNREAD')}>
                    <EyeOff className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Mark Unread</span>
                </Button>
                
                <Button size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedSeries.size > 0 ? 'text-slate-600 hover:bg-slate-100' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'}`} disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => setBulkListModalOpen(true)}>
                    <ListPlus className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Add to List</span>
                </Button>

                {activeCollection !== "ALL" && (
                    <Button size="sm" variant="destructive" className="h-10 sm:h-8 shadow-sm font-bold ml-1 sm:ml-2 transition-all" disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => handleBulkAdvanced('bulk-remove-list', activeCollection)}>
                        <Minus className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Remove</span>
                    </Button>
                )}

                {isAdmin && (
                  <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="outline" disabled={selectedSeries.size === 0 || isBulkProcessing} className="h-10 sm:h-8 shadow-sm font-bold bg-white dark:bg-slate-950 ml-1 sm:ml-2">
                              <MoreHorizontal className="w-4 h-4" />
                          </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56 dark:bg-slate-950 dark:border-slate-800 z-[100]">
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-monitor', 'MONITOR')} className="cursor-pointer font-medium h-10 sm:h-8">
                              <Activity className="w-4 h-4 mr-2 text-blue-500" /> Monitor Series
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-monitor', 'UNMONITOR')} className="cursor-pointer font-medium text-slate-500 h-10 sm:h-8">
                              <EyeOff className="w-4 h-4 mr-2" /> Stop Monitoring
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="dark:bg-slate-800" />
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-manga', 'MANGA')} className="cursor-pointer font-medium h-10 sm:h-8">
                              <ArrowRightLeft className="w-4 h-4 mr-2 text-purple-500" /> Move to Manga
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-manga', 'COMIC')} className="cursor-pointer font-medium h-10 sm:h-8">
                              <ArrowRightLeft className="w-4 h-4 mr-2 text-green-500" /> Move to Comics
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="dark:bg-slate-800" />
                          <DropdownMenuItem onClick={() => setRenameModalOpen(true)} className="cursor-pointer font-medium h-10 sm:h-8">
                              <FileEdit className="w-4 h-4 mr-2 text-indigo-500" /> Standardize File Names
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={handleBulkRefresh} className="cursor-pointer font-medium h-10 sm:h-8">
                              <RefreshCw className="w-4 h-4 mr-2 text-orange-500" /> Refresh Metadata
                          </DropdownMenuItem>
                      </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {isAdmin && (
                  <Button size="sm" className={`h-10 sm:h-8 shadow-sm font-bold ml-1 sm:ml-2 transition-all ${selectedSeries.size > 0 ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'}`} disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => setBulkDeleteModalOpen(true)}>
                      <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
          </div>
      )}

      {/* MANAGE LISTS MODAL */}
      <Dialog open={manageListsOpen} onOpenChange={setManageListsOpen}>
        <DialogContent className="sm:max-w-[425px] w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
          <DialogHeader>
            <DialogTitle>Manage Reading Lists</DialogTitle>
            <DialogDescription>View and delete your custom collections.</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {collections.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6 border-2 border-dashed dark:border-slate-800 rounded-lg">You haven't created any lists yet.</p>
            ) : (
                collections.map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border dark:border-slate-800">
                        <div>
                            <p className="font-bold text-sm text-slate-900 dark:text-slate-100">{c.name}</p>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mt-0.5">{c.items?.length || 0} Items</p>
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setCollectionToDelete(c.id)}>
                            <Trash2 className="w-4 h-4" />
                        </Button>
                    </div>
                ))
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setManageListsOpen(false)} variant="outline" className="w-full sm:w-auto h-12 sm:h-10">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* NEW BULK LIST MODAL */}
      <Dialog open={bulkListModalOpen} onOpenChange={setBulkListModalOpen}>
        <DialogContent className="sm:max-w-[425px] w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
          <DialogHeader>
            <DialogTitle>Add to Reading List</DialogTitle>
            <DialogDescription>Add <strong>{selectedSeries.size} selected series</strong> to a collection to organize your library.</DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label>Select Existing List</Label>
              <Select value={selectedCollectionId} onValueChange={(v) => { setSelectedCollectionId(v); setNewCollectionName(""); }}>
                <SelectTrigger className="bg-white dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10"><SelectValue placeholder="Choose a list..." /></SelectTrigger>
                <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                  {collections.length === 0 && <SelectItem value="none" disabled>No lists available</SelectItem>}
                  {collections.map(c => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Or Create New List</Label>
              <Input placeholder="e.g. Webtoons, Marvel Events, Mature..." value={newCollectionName} className="bg-white h-12 sm:h-10 dark:bg-slate-900 dark:border-slate-800" onChange={e => {setNewCollectionName(e.target.value); setSelectedCollectionId("");}} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitBulkAddToCollection} disabled={addingToList || (!selectedCollectionId && !newCollectionName.trim())} className="bg-blue-600 hover:bg-blue-700 text-white font-bold w-full h-12 sm:h-10">
               {addingToList ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <ListPlus className="w-5 h-5 mr-2" />} Save to List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* RENAME FILES MODAL */}
      <Dialog open={renameModalOpen} onOpenChange={setRenameModalOpen}>
        <DialogContent className="sm:max-w-[450px] w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2"><FileEdit className="w-5 h-5 text-indigo-500"/> Standardize File Names</DialogTitle>
                <DialogDescription className="pt-2">
                    Omnibus will enforce the standard folder structure and perfectly rename all physical `.cbz` / `.cbr` files based on your chosen convention.
                </DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-4">
                <div className="space-y-2">
                    <Label>Select Naming Convention</Label>
                    <Select value={renamePattern} onValueChange={setRenamePattern}>
                        <SelectTrigger className="dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                            <SelectItem value="{Series} ({Year}) - #{Issue}">Series (Year) - #Issue</SelectItem>
                            <SelectItem value="[{Publisher}] {Series} ({Year}) - #{Issue}">[Publisher] Series (Year) - #Issue</SelectItem>
                            <SelectItem value="{Series} #{Issue}">Series #Issue</SelectItem>
                            <SelectItem value="{Series} - v{Year} - {Issue}">Series - vYear - Issue</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="bg-slate-100 dark:bg-slate-900 p-3 rounded-lg border dark:border-slate-800 text-xs text-muted-foreground">
                    <span className="font-bold text-slate-700 dark:text-slate-300 mb-1 block">Live Example Preview:</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">
                    {renamePattern
                        .replace('{Publisher}', 'Marvel')
                        .replace('{Series}', 'Cyclops')
                        .replace('{Year}', '2026')
                        .replace('{Issue}', '001')}.cbz
                    </span>
                </div>
            </div>
            <DialogFooter className="flex gap-2 sm:gap-0">
                <Button variant="outline" onClick={() => setRenameModalOpen(false)} disabled={isBulkProcessing} className="h-12 sm:h-10">Cancel</Button>
                <Button className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold h-12 sm:h-10" onClick={handleBulkRename} disabled={isBulkProcessing}>
                    {isBulkProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <FileEdit className="w-5 h-5 mr-2" />} Standardize Files
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkDeleteModalOpen} onOpenChange={setBulkDeleteModalOpen}>
          <DialogContent className="sm:max-w-[425px] w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
              <DialogHeader><DialogTitle className="text-red-600 flex items-center gap-2"><Trash2 className="w-5 h-5"/> Delete {selectedSeries.size} Series?</DialogTitle><DialogDescription className="pt-2">You are about to remove <strong>{selectedSeries.size}</strong> series from your library database.</DialogDescription></DialogHeader>
              <div className="py-4"><div className="flex items-center space-x-2 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-900/50"><Switch id="bulk-delete-files" checked={bulkDeleteFiles} onCheckedChange={setBulkDeleteFiles} /><Label htmlFor="bulk-delete-files" className="text-sm font-semibold text-red-800 dark:text-red-400 cursor-pointer">Also delete physical folders and files from disk</Label></div></div>
              <DialogFooter className="flex gap-2 sm:gap-0"><Button variant="outline" onClick={() => setBulkDeleteModalOpen(false)} disabled={isBulkProcessing} className="h-12 sm:h-10">Cancel</Button><Button variant="destructive" onClick={handleBulkDelete} disabled={isBulkProcessing} className="h-12 sm:h-10">{isBulkProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Trash2 className="w-5 h-5 mr-2" />} Delete All</Button></DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={!!targetSeries} onOpenChange={(open) => !open && setTargetSeries(null)}>
        <DialogContent className="sm:max-w-[425px] w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
          <DialogHeader><DialogTitle>Add to Reading List</DialogTitle><DialogDescription>Add <strong className="text-primary">{targetSeries?.name}</strong> to a collection.</DialogDescription></DialogHeader>
          <div className="space-y-6 py-4">
              <div className="space-y-2"><Label>Select Existing List</Label><Select value={selectedCollectionId} onValueChange={(v) => { setSelectedCollectionId(v); setNewCollectionName(""); }}><SelectTrigger className="bg-white dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10"><SelectValue placeholder="Choose a list..." /></SelectTrigger><SelectContent className="dark:bg-slate-950 dark:border-slate-800">{collections.length === 0 && <SelectItem value="none" disabled>No lists available</SelectItem>}{collections.map(c => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}</SelectContent></Select></div>
              <div className="space-y-2"><Label>Create New List</Label><Input placeholder="e.g. Marvel Events" value={newCollectionName} className="bg-white dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10" onChange={e => {setNewCollectionName(e.target.value); setSelectedCollectionId("");}} /></div>
          </div>
          <DialogFooter><Button onClick={submitAddToCollection} disabled={addingToList || (!selectedCollectionId && !newCollectionName.trim())} className="h-12 sm:h-10 w-full sm:w-auto font-bold bg-blue-600 hover:bg-blue-700 text-white">Save to List</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={!!editing} onOpenChange={() => !updating && setEditing(null)}>
        <DialogContent className="sm:max-w-[425px] w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Edit Metadata</DialogTitle></DialogHeader>
            {editing && (
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label>Source Folder Path</Label>
                        <div className="flex gap-2">
                            <Input readOnly value={editing.path || ""} className="bg-slate-100 dark:bg-slate-900 text-xs truncate dark:border-slate-800 text-muted-foreground h-12 sm:h-10" />
                            <Button variant="secondary" size="icon" onClick={copyToClipboard} type="button" className="shrink-0 h-12 w-12 sm:h-10 sm:w-10">{copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}</Button>
                        </div>
                    </div>
                    <div className="grid gap-2"><Label htmlFor="cvId">ComicVine ID</Label><Input id="cvId" type="number" value={editing.cvId || ""} onChange={e => setEditing({...editing, cvId: e.target.value ? parseInt(e.target.value) : null})} className="dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10 text-lg" /></div>
                    <div className="grid gap-2"><Label htmlFor="publisher">Publisher</Label><Input id="publisher" value={editing.publisher || ""} onChange={e => setEditing({...editing, publisher: e.target.value})} className="dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10" /></div>
                    <div className="grid gap-2"><Label htmlFor="name">Series Name</Label><Input id="name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} className="dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10" /></div>
                    <div className="grid gap-2"><Label htmlFor="year">Year</Label><Input id="year" type="number" value={editing.year || ""} onChange={e => setEditing({...editing, year: e.target.value})} className="dark:bg-slate-900 dark:border-slate-800 h-12 sm:h-10" /></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                        <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border dark:border-slate-800"><Switch id="monitor-switch" checked={editing.monitored || false} onCheckedChange={v => setEditing({...editing, monitored: v})} /><Label htmlFor="monitor-switch" className="cursor-pointer">Monitor Series</Label></div>
                        <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg border dark:border-slate-800"><Switch id="manga-switch" checked={editing.isManga || false} onCheckedChange={v => setEditing({...editing, isManga: v})} /><Label htmlFor="manga-switch" className="cursor-pointer">Flag as Manga</Label></div>
                    </div>
                </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" onClick={() => setEditing(null)} disabled={updating} className="h-12 sm:h-10 w-full sm:w-auto">Cancel</Button><Button onClick={handleUpdateMetadata} disabled={updating} className="bg-blue-600 hover:bg-blue-700 text-white font-bold h-12 sm:h-10 w-full sm:w-auto">{updating ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null} Save Changes</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      
      <ConfirmationDialog isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={handleConfirmedRefresh} variant="default" title="Refresh Metadata?" description="This will re-fetch the latest data from ComicVine." confirmText="Refresh" />
      
      <ConfirmationDialog 
          isOpen={!!collectionToDelete} 
          onClose={() => setCollectionToDelete(null)} 
          onConfirm={handleDeleteCollection} 
          variant="destructive" 
          title="Delete Reading List?" 
          description="Are you sure you want to delete this reading list? This will NOT delete the actual comics inside it." 
          confirmText="Delete List" 
      />
    </div>
  )
}