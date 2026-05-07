// src/app/library/page.tsx
"use client"

import { useState, useEffect, useCallback, useRef, Suspense } from "react"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { 
  BookOpen, RefreshCw, Folder, Settings2, Loader2, Image as ImageIcon, ExternalLink, 
  Search, SortAsc, Filter, LayoutGrid, List, Check, Heart, ListPlus, Minus, Layers, Trash2,
  CheckSquare, Square, EyeOff, Copy, MoreHorizontal, Activity, ArrowRightLeft, FileEdit,
  Dices, Clock, X, DownloadCloud, PenTool, Paintbrush, Users, FolderSearch
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
import { InteractiveSearchModal } from "@/components/interactive-search-modal"

interface Comic {
  id: string; // Prisma ID
  cvId: number; // ComicVine ID
  volumeId: number; 
  name: string;
  issueNumber?: string;
  year: string;
  publisher: string;
  image: string;
  description?: string;
  siteUrl?: string;
  writers?: string[];
  artists?: string[];
  coverArtists?: string[];
  characters?: string[];
  isVolume?: boolean;
  [key: string]: any;
}

interface LibrarySeries {
  id: string;
  path: string;
  name: string;
  cover?: string;
  publisher?: string;
  year?: string;
  count: number;
  unreadCount?: number;
  progressPercentage?: number;
  isFavorite: boolean;
  cvId?: number;
  monitored?: boolean;
  isManga?: boolean;
  matchState?: string;
  isPendingReq?: boolean;
}

interface Collection {
  id: string;
  name: string;
  items?: { id: string }[];
}

type StatusType = 'LIBRARY_MONITORED' | 'LIBRARY_UNMONITORED' | 'ISSUE_OWNED' | 'REQUESTED' | 'PENDING_APPROVAL' | null;

function LibrarySkeleton({ count = 24 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10" aria-hidden="true">
      {[...Array(count)].map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="aspect-[2/3] rounded-xl bg-muted animate-pulse" />
          <div className="h-3 w-3/4 bg-muted animate-pulse rounded" />
          <div className="h-2 w-1/2 bg-muted animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}

function LibraryContent() {
  const { data: session } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams() 
  const { toast } = useToast()

  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [series, setSeries] = useState<LibrarySeries[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  
  const [pageSize, setPageSize] = useState<number>(24);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const [editing, setEditing] = useState<LibrarySeries | null>(null)
  const [updating, setUpdating] = useState(false)
  const [copied, setCopied] = useState(false);
  
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || "")
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get('q') || "") 
  const [searchType, setSearchType] = useState("ALL") 
  const [publisherFilter, setPublisherFilter] = useState("ALL")
  const [uniquePublishers, setUniquePublishers] = useState<string[]>([])
  const [libraryFilter, setLibraryFilter] = useState<'ALL' | 'COMICS' | 'MANGA' | 'UNMATCHED' | 'PENDING'>('ALL') 
  const [sortOption, setSortOption] = useState("alpha_asc")
  
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false) 
  const [monitoredFilter, setMonitoredFilter] = useState(false)
  const [eraFilter, setEraFilter] = useState("ALL")
  const [readStatus, setReadStatus] = useState("ALL")
  const [randomTrigger, setRandomTrigger] = useState(0)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [refreshTarget, setRefreshTarget] = useState<{cvId: number, path: string} | null>(null)
  
  const [collections, setCollections] = useState<Collection[]>([])
  const [activeCollection, setActiveCollection] = useState("ALL")
  const [targetSeries, setTargetSeries] = useState<LibrarySeries | null>(null)
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
  const [repackModalOpen, setRepackModalOpen] = useState(false);
  
  // --- NEW STANDARDIZE NAMES STATE ---
  const [folderPattern, setFolderPattern] = useState("{Publisher}/{Series} ({Year})");
  const [filePattern, setFilePattern] = useState("{Series} #{Issue}");
  const [renamePreviews, setRenamePreviews] = useState<any[]>([]);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  useEffect(() => {
      if (renameModalOpen && selectedSeries.size > 0) {
          setIsLoadingPreview(true);
          fetch('/api/library/rename/preview', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  seriesIds: Array.from(selectedSeries), 
                  folderPattern, 
                  filePattern 
              })
          })
          .then(res => res.json())
          .then(data => { if (data.previews) setRenamePreviews(data.previews); })
          .catch(() => {})
          .finally(() => setIsLoadingPreview(false));
      } else {
          setRenamePreviews([]);
      }
  }, [renameModalOpen, folderPattern, filePattern, selectedSeries]);

  const [navigatingTo, setNavigatingTo] = useState<string | null>(null);

  const [selectedComic, setSelectedComic] = useState<Comic | null>(null)
  const [relatedIssues, setRelatedIssues] = useState<Comic[]>([])
  const [loadingRelated, setLoadingRelated] = useState(false)
  
  const [ownedSeries, setOwnedSeries] = useState<Set<number>>(new Set())
  const [monitoredSeries, setMonitoredSeries] = useState<Set<number>>(new Set())
  const [ownedIssues, setOwnedIssues] = useState<Set<number>>(new Set())
  const [activeRequests, setActiveRequests] = useState<any[]>([])
  const [requestedVolumes, setRequestedVolumes] = useState<Set<number>>(new Set())
  const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set())

  const isAdmin = (session?.user as any)?.role === 'ADMIN'

  const filtersRef = useRef({
      search: debouncedSearch, type: searchType, library: libraryFilter, pub: publisherFilter,
      sort: sortOption, favs: showFavoritesOnly, monitored: monitoredFilter, era: eraFilter,
      read: readStatus, col: activeCollection, limit: pageSize, random: randomTrigger
  });

  useEffect(() => {
      const qParam = searchParams.get('q');
      if (qParam) {
          setSearchQuery(qParam);
          setDebouncedSearch(qParam);
      }
  }, [searchParams]);

  useEffect(() => {
      filtersRef.current = {
          search: debouncedSearch, type: searchType, library: libraryFilter, pub: publisherFilter,
          sort: sortOption, favs: showFavoritesOnly, monitored: monitoredFilter, era: eraFilter,
          read: readStatus, col: activeCollection, limit: pageSize, random: randomTrigger
      };
  }, [debouncedSearch, searchType, libraryFilter, publisherFilter, sortOption, showFavoritesOnly, monitoredFilter, eraFilter, readStatus, activeCollection, pageSize, randomTrigger]);

  useEffect(() => {
      document.title = "Omnibus - Library";
      const timer = setTimeout(() => setDebouncedSearch(searchQuery), 500);
      return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
      const qParam = searchParams.get('q') || "";
      if (qParam !== debouncedSearch) {
          setSearchQuery(qParam);
          setDebouncedSearch(qParam);
      }
  }, [searchParams]);

  useEffect(() => {
      fetch('/api/admin/config')
          .then(res => res.ok ? res.json() : null)
          .then(data => {
              if (data?.settings) {
                  const savedFolder = data.settings.find((s: any) => s.key === 'folder_naming_pattern')?.value;
                  const savedFile = data.settings.find((s: any) => s.key === 'file_naming_pattern')?.value;
                  
                  if (savedFolder) setFolderPattern(savedFolder);
                  if (savedFile) setFilePattern(savedFile);
              }
          })
          .catch(() => {});
  }, []);
  
  useEffect(() => {
    fetch('/api/library/ids')
      .then(res => res.json())
      .then(data => { 
          if (data) {
              setOwnedSeries(new Set(data.series || []));
              setMonitoredSeries(new Set(data.monitored || []));
              setOwnedIssues(new Set(data.issues || []));
              setActiveRequests(data.requests || []);
          }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedComic?.cvId) return;
    
    fetch(`/api/issue-details?id=${selectedComic.cvId}&type=volume&_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        if (data && !data.error) {
          setSelectedComic(prev => {
            if (prev?.id !== selectedComic.id) return prev; 
            return {
                ...prev,
                ...data,
                name: prev?.name || data.name,
                publisher: (data.publisher && data.publisher !== 'Unknown') ? data.publisher : prev?.publisher,
                year: (data.year && data.year !== '????') ? data.year : prev?.year,
                image: data.image || prev?.image || prev?.cover,
                description: data.description?.trim() ? data.description : prev?.description,
                writers: data.writers,
                artists: data.artists,
                characters: data.characters
            } as Comic;
          });
        }
      });
  }, [selectedComic?.id, selectedComic?.cvId]);

  useEffect(() => {
    if (!selectedComic?.cvId) { setRelatedIssues([]); return; }
    setLoadingRelated(true)
    fetch(`/api/series-issues?volumeId=${selectedComic.cvId}`)
      .then(res => res.json())
      .then(data => {
        if (data.results) {
           const sorted = data.results.sort((a: any, b: any) => (parseFloat(b.issueNumber) || 0) - (parseFloat(a.issueNumber) || 0));
           setRelatedIssues(sorted);
        }
      })
      .finally(() => setLoadingRelated(false))
  }, [selectedComic?.cvId])

  const loadLibraryData = useCallback(async (pageNum: number, isRefreshScan: boolean, appendResults: boolean) => {
      if (isRefreshScan) setIsRefreshing(true);
      else if (pageNum === 1) setLoading(true);
      else setLoadingMore(true);

      const f = filtersRef.current;
      const params = new URLSearchParams();
      params.append('page', pageNum.toString());
      params.append('limit', f.limit.toString());
      
      if (isRefreshScan) params.append('refresh', 'true');
      if (f.search.trim()) { params.append('q', f.search.trim()); params.append('type', f.type); }
      if (f.library !== 'ALL' && f.library !== 'UNMATCHED' && f.library !== 'PENDING') params.append('library', f.library);
      if (f.library === 'UNMATCHED') params.append('unmatched', 'true');
      if (f.library === 'PENDING') params.append('pending', 'true');
      if (f.pub !== 'ALL') params.append('publisher', f.pub);
      if (f.sort) params.append('sort', f.sort);
      if (f.favs) params.append('favorites', 'true');
      if (f.monitored) params.append('monitored', 'true');
      if (f.era !== 'ALL') params.append('era', f.era);
      if (f.read !== 'ALL') params.append('readStatus', f.read);
      if (f.col !== 'ALL') params.append('collection', f.col);
      if (f.sort === 'random') params.append('_t', Date.now().toString());

      try {
          const res = await fetch(`/api/library?${params.toString()}`, { cache: 'no-store' });
          const data = await res.json();
          
          if (!res.ok && data.error) {
              toastRef.current({ title: "Scan Aborted", description: data.error, variant: "destructive" });
              return;
          }

          if (data.series) {
              setSeries(prev => {
                  if (!appendResults) return data.series;
                  const existingIds = new Set(prev.map((s: LibrarySeries) => s.id || s.path));
                  const newItems = data.series.filter((s: LibrarySeries) => !existingIds.has(s.id || s.path));
                  return [...prev, ...newItems];
              });
              setHasMore(data.hasMore);
          }
          if (data.publishers) {
              setUniquePublishers(data.publishers);
          }
      } catch (e: any) {
          toastRef.current({ title: "Error", description: "Failed to fetch library data.", variant: "destructive" });
      } finally { 
          setLoading(false); 
          setLoadingMore(false); 
          setIsRefreshing(false); 
      }
  }, []);

  const fetchCollections = useCallback(async () => {
    try {
      const res = await fetch('/api/library/collections', { cache: 'no-store' });
      if (res.ok) setCollections(await res.json());
    } catch (e) {}
  }, []);

  const isFirstRender = useRef(true);

  useEffect(() => {
      fetchCollections();
      
      let isRefetch = false;
      if (typeof window !== 'undefined') {
          const savedView = localStorage.getItem('omnibus-library-view');
          if (savedView === 'grid' || savedView === 'list') setViewMode(savedView);
          
          const savedSize = localStorage.getItem('omnibus-library-pagesize');
          if (savedSize) {
              setPageSize(parseInt(savedSize));
              filtersRef.current.limit = parseInt(savedSize);
          }

          const params = new URLSearchParams(window.location.search);
          if (params.get('refetch') === 'true') {
              isRefetch = true;
              const newUrl = new URL(window.location.href);
              newUrl.searchParams.delete('refetch');
              window.history.replaceState({}, '', newUrl.toString());
          }
      }
      
      loadLibraryData(1, isRefetch, false);
      
      setTimeout(() => {
          isFirstRender.current = false;
      }, 100);
      
  }, [loadLibraryData, fetchCollections]);

  useEffect(() => { 
      if (isFirstRender.current) return;
      setPage(1); 
      loadLibraryData(1, false, false); 
  }, [debouncedSearch, searchType, libraryFilter, publisherFilter, sortOption, showFavoritesOnly, activeCollection, monitoredFilter, eraFilter, readStatus, randomTrigger, pageSize, loadLibraryData])

  const toggleViewMode = (mode: 'grid' | 'list') => {
      setViewMode(mode)
      localStorage.setItem('omnibus-library-view', mode)
  }

  const handlePageSizeChange = (val: string) => {
      const newSize = parseInt(val);
      setPageSize(newSize);
      localStorage.setItem('omnibus-library-pagesize', val);
  }

  const handleNavigate = (e: React.MouseEvent | React.KeyboardEvent, path: string, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      setNavigatingTo(id);
      router.push(`/library/series?path=${encodeURIComponent(path)}`);
      setTimeout(() => setNavigatingTo(null), 2000); 
  }

  const handleSurpriseMe = () => {
      setSortOption("random");
      setRandomTrigger(prev => prev + 1); 
      window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const handleResetFilters = () => {
      setSearchQuery("");
      setSearchType("ALL");
      setPublisherFilter("ALL");
      setLibraryFilter("ALL");
      setSortOption("alpha_asc");
      setShowFavoritesOnly(false);
      setMonitoredFilter(false);
      setEraFilter("ALL");
      setReadStatus("ALL");
      setActiveCollection("ALL");
      window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const handleRefresh = () => {
      setPage(1);
      loadLibraryData(1, true, false);
      toastRef.current({ title: "Scanning Disk", description: "Checking folders for new comics..." });
  }

  const observer = useRef<IntersectionObserver | null>(null);
  const lastElementRef = useCallback((node: HTMLDivElement | null) => {
      if (loading || loadingMore) return; 
      if (observer.current) observer.current.disconnect();
      
      observer.current = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting && hasMore) {
              setPage(prevPage => {
                  const nextPage = prevPage + 1;
                  loadLibraryData(nextPage, false, true);
                  return nextPage;
              });
          }
      }, { rootMargin: "400px" }); 
      
      if (node) observer.current.observe(node);
  }, [hasMore, loading, loadingMore, loadLibraryData]); 

  const toggleFavorite = async (seriesId: string, currentStatus: boolean) => {
      if (!seriesId) return;
      setSeries(prev => prev.map(s => s.id === seriesId ? { ...s, isFavorite: !currentStatus } : s));
      
      try { 
          const res = await fetch('/api/library/favorite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesId }) }); 
          if (!res.ok) throw new Error("Failed to favorite");
      } catch (e) {
          setSeries(prev => prev.map(s => s.id === seriesId ? { ...s, isFavorite: currentStatus } : s));
          toastRef.current({ title: "Error", description: "Failed to update favorite status.", variant: "destructive" });
      }
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
              toastRef.current({ title: "Success", description: "Series added to list." });
              setTargetSeries(null); setNewCollectionName(""); setSelectedCollectionId(""); fetchCollections(); 
          } else throw new Error("Failed to add to list");
      } catch (e) { 
          toastRef.current({ variant: "destructive", title: "Error", description: "Could not add to list." }); 
      } finally { setAddingToList(false); }
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
              toastRef.current({ title: "Mass Tagging Complete", description: `Added ${selectedSeries.size} series to your list.` });
              setBulkListModalOpen(false); setNewCollectionName(""); setSelectedCollectionId("");
              setSelectedSeries(new Set()); setIsSelectionMode(false);
              fetchCollections(); 
          } else throw new Error("Failed to add to list");
      } catch (e) { 
          toastRef.current({ variant: "destructive", title: "Error", description: "Could not add to list." }); 
      } finally { setAddingToList(false); }
  }

  const handleRemoveFromCollection = async (seriesId: string) => {
      try {
          const res = await fetch('/api/library/collections/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId: activeCollection, seriesId, action: 'remove' }) });
          if (res.ok) { 
              toastRef.current({ title: "Removed", description: "Series removed from list." }); 
              fetchCollections(); 
              loadLibraryData(1, false, false); 
          } else throw new Error("Failed to remove");
      } catch (e) { 
          toastRef.current({ title: "Error", description: "Failed to remove from list.", variant: "destructive" });
      }
  }

  const handleDeleteCollection = async () => {
      if (!collectionToDelete) return;
      try {
          const res = await fetch(`/api/library/collections?id=${collectionToDelete}`, { method: 'DELETE' });
          if (res.ok) {
              toastRef.current({ title: "List Deleted" });
              if (activeCollection === collectionToDelete) setActiveCollection("ALL");
              fetchCollections();
          } else {
              toastRef.current({ title: "Error", description: "Could not delete list.", variant: "destructive" });
          }
      } catch (e) { 
          toastRef.current({ title: "Error", variant: "destructive" }); 
      } finally {
          setCollectionToDelete(null);
      }
  }

  const copyToClipboard = () => {
    if (editing?.path) {
      navigator.clipboard.writeText(editing.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toastRef.current({ title: "Path Copied" });
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
            cvId: editing.cvId ? editing.cvId : null, monitored: editing.monitored, isManga: editing.isManga
        })
      });
      if (res.ok) {
        toastRef.current({ title: "Success!", description: "Series info updated." });
        setEditing(null);
        setPage(1);
        loadLibraryData(1, false, false);
      } else {
        const err = await res.json(); toastRef.current({ title: "Update Failed", description: err.error || "Unknown error", variant: "destructive" });
      }
    } catch (e: any) { toastRef.current({ title: "Error", description: e.message, variant: "destructive" }); } finally { setUpdating(false) }
  }

  const initiateRefreshMetadata = (cvId: number | undefined, folderPath: string) => {
    if (!cvId) { toastRef.current({ title: "Missing ID", description: "This folder isn't linked to a ComicVine ID. Use 'Edit Info' to add one." }); return; }
    setRefreshTarget({ cvId, path: folderPath }); setConfirmOpen(true);
  }

  const handleConfirmedRefresh = async () => {
    if (!refreshTarget) return;
    setLoading(true); setConfirmOpen(false);
    try {
      const res = await fetch('/api/library/refresh-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cvId: refreshTarget.cvId, folderPath: refreshTarget.path }) });
      if (res.ok) { 
          toastRef.current({ title: "Success", description: "Metadata and cover art refreshed!" }); 
          setPage(1); loadLibraryData(1, false, false); 
      } else throw new Error("Failed to refresh");
    } catch (e) {
        toastRef.current({ title: "Error", description: "Failed to refresh metadata.", variant: "destructive" });
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
            toastRef.current({ title: "Bulk Update Success", description: `Marked ${selectedSeries.size} series as ${isRead ? 'read' : 'unread'}.` });
            setSeries(prev => prev.map(s => selectedSeries.has(s.id) ? { ...s, unreadCount: isRead ? 0 : s.count, progressPercentage: isRead ? 100 : 0 } : s));
            setSelectedSeries(new Set()); setIsSelectionMode(false);
        } else throw new Error("Failed");
    } catch (e) { toastRef.current({ title: "Update Failed", variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const handleBulkAdvanced = async (action: string, status: string) => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesIds: Array.from(selectedSeries), action, status }) });
          if (res.ok) {
              toastRef.current({ title: "Bulk Update Complete" }); 
              if (action === 'bulk-remove-list') fetchCollections();
              setPage(1);
              loadLibraryData(1, false, false); 
              setSelectedSeries(new Set()); 
              setIsSelectionMode(false);
          } else {
              const data = await res.json(); toastRef.current({ title: "Update Failed", description: data.error, variant: "destructive" });
          }
      } catch (e) { toastRef.current({ title: "Error", variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const handleBulkRefresh = async () => {
      const seriesList = series.filter(s => selectedSeries.has(s.id));
      setIsBulkProcessing(true);
      toastRef.current({ title: "Starting Metadata Refresh", description: `Queued ${seriesList.length} series. Please keep this page open.` });
      
      let successCount = 0;
      let failCount = 0;
      for (let i = 0; i < seriesList.length; i++) {
          const s = seriesList[i];
          if (!s.cvId) continue; 
          try {
              const res = await fetch('/api/library/refresh-metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cvId: s.cvId, folderPath: s.path }) });
              if (res.ok) successCount++;
              else failCount++;
          } catch(e) {
              failCount++;
          }
          
          if (i < seriesList.length - 1) await new Promise(r => setTimeout(r, 4000));
      }
      
      toastRef.current({ title: "Refresh Complete", description: `Successfully refreshed ${successCount} series. ${failCount > 0 ? `Failed: ${failCount}` : ''}` });
      setPage(1);
      loadLibraryData(1, false, false); setIsBulkProcessing(false); setSelectedSeries(new Set()); setIsSelectionMode(false);
  }

  const handleBulkRename = async () => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  seriesIds: Array.from(selectedSeries), 
                  folderPattern, 
                  filePattern 
              })
          });
          if (res.ok) {
              const data = await res.json();
              toastRef.current({ title: "Renaming Complete", description: `Successfully renamed ${data.filesRenamed} files across ${data.foldersRenamed > 0 ? data.foldersRenamed : 'selected'} folders.` });
              setRenameModalOpen(false); setSelectedSeries(new Set()); setIsSelectionMode(false); setPage(1); loadLibraryData(1, false, false);
          } else {
              const data = await res.json(); toastRef.current({ title: "Renaming Failed", description: data.error, variant: "destructive" });
          }
      } catch (e) { toastRef.current({ title: "Error", variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const handleBulkRepack = async () => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library/repack', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seriesIds: Array.from(selectedSeries) })
          });
          if (res.ok) {
              toastRef.current({ title: "Job Queued", description: "Internal repacking started in the background. Check System Logs for progress." });
              setRepackModalOpen(false); 
              setSelectedSeries(new Set()); 
              setIsSelectionMode(false);
          } else {
              const data = await res.json(); 
              toastRef.current({ title: "Repack Failed", description: data.error, variant: "destructive" });
          }
      } catch (e) { 
          toastRef.current({ title: "Error", variant: "destructive" }); 
      } finally { 
          setIsBulkProcessing(false); 
      }
  }

  const handleBulkDelete = async () => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library/series', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesIds: Array.from(selectedSeries), deleteFiles: bulkDeleteFiles }) });
          if (!res.ok) throw new Error("Failed to delete selected series.");
          toastRef.current({ title: "Series Deleted", description: `Successfully removed ${selectedSeries.size} series.` });
          setSeries(prev => prev.filter(s => !selectedSeries.has(s.id)));
          setSelectedSeries(new Set()); setIsSelectionMode(false); setBulkDeleteModalOpen(false);
      } catch (e: any) { toastRef.current({ title: "Delete Failed", description: e.message, variant: "destructive" }); } finally { setIsBulkProcessing(false); }
  }

  const hasActiveFilters = searchQuery !== "" || searchType !== "ALL" || publisherFilter !== "ALL" || libraryFilter !== "ALL" || sortOption !== "alpha_asc" || showFavoritesOnly || monitoredFilter || eraFilter !== "ALL" || readStatus !== "ALL" || activeCollection !== "ALL";

  return (
    <div className="container mx-auto py-10 px-6 relative transition-colors duration-300">
      
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">Library</h1>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 w-full sm:w-auto justify-between sm:justify-end">
            <div className="flex bg-muted p-1 rounded-md shrink-0 shadow-inner border border-border overflow-x-auto max-w-full" role="tablist" aria-label="Library Section Filters">
                <Button role="tab" aria-selected={libraryFilter === 'ALL'} variant={libraryFilter === 'ALL' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'ALL' ? 'shadow-sm bg-background text-foreground' : 'text-muted-foreground'}`} onClick={() => setLibraryFilter('ALL')}>All</Button>
                <Button role="tab" aria-selected={libraryFilter === 'COMICS'} variant={libraryFilter === 'COMICS' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'COMICS' ? 'shadow-sm bg-background text-foreground' : 'text-muted-foreground'}`} onClick={() => setLibraryFilter('COMICS')}>Comics</Button>
                <Button role="tab" aria-selected={libraryFilter === 'MANGA'} variant={libraryFilter === 'MANGA' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'MANGA' ? 'shadow-sm bg-background text-foreground' : 'text-muted-foreground'}`} onClick={() => setLibraryFilter('MANGA')}>Manga</Button>
                {isAdmin && (
                    <Button role="tab" aria-selected={libraryFilter === 'UNMATCHED'} variant={libraryFilter === 'UNMATCHED' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'UNMATCHED' ? 'shadow-sm bg-orange-500 hover:bg-orange-600 text-white' : 'text-orange-500 hover:text-orange-600'}`} onClick={() => setLibraryFilter('UNMATCHED')}>
                        Unmatched
                    </Button>
                )}
                {/* --- NEW PENDING BUTTON --- */}
                {isAdmin && (
                    <Button role="tab" aria-selected={libraryFilter === 'PENDING'} variant={libraryFilter === 'PENDING' ? 'default' : 'ghost'} size="sm" className={`h-8 sm:h-7 px-3 text-xs ${libraryFilter === 'PENDING' ? 'shadow-sm bg-blue-500 hover:bg-blue-600 text-white' : 'text-blue-500 hover:text-blue-600'}`} onClick={() => setLibraryFilter('PENDING')}>
                        Pending
                    </Button>
                )}
            </div>
            
            <div className="flex items-center gap-2 shrink-0">
                <Button aria-label={isSelectionMode ? "Cancel series selection" : "Enter series selection mode"} variant={isSelectionMode ? "secondary" : "outline"} size="sm" onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedSeries(new Set()); }} className={`h-10 sm:h-9 ${isSelectionMode ? "bg-primary/20 text-primary border-primary/50 hover:bg-primary/30" : "border-border"}`}>
                    <CheckSquare className="w-4 h-4 mr-2" /> {isSelectionMode ? "Cancel Select" : "Select"}
                </Button>
                <Button aria-label="Scan library folders for new files" onClick={handleRefresh} disabled={loading || isRefreshing} variant="outline" size="sm" className="h-10 sm:h-9 border-border">
                {isRefreshing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />} Refresh
                </Button>
            </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 mb-8 bg-muted/50 p-4 rounded-lg border border-border transition-colors duration-300" role="group" aria-label="Advanced Search and Filtering">
          
          <div className="flex flex-col lg:flex-row gap-3 items-start lg:items-center w-full">
              <div className="relative flex flex-col sm:flex-row flex-1 w-full gap-2">
                  <Select value={searchType} onValueChange={setSearchType}>
                      <SelectTrigger aria-label="Filter search by field" className="w-full sm:w-[140px] bg-background shadow-sm border-border shrink-0 h-10 sm:h-9">
                          <SelectValue placeholder="Search In" />
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border">
                          <SelectItem value="ALL">Everything</SelectItem>
                          <SelectItem value="TITLE">Title / Pub</SelectItem>
                          <SelectItem value="WRITER">Writer</SelectItem>
                          <SelectItem value="ARTIST">Artist</SelectItem>
                          <SelectItem value="CHARACTER">Character</SelectItem>
                          <SelectItem value="TEAM">Team</SelectItem>
                          <SelectItem value="ARC">Story Arc</SelectItem>
                          <SelectItem value="LOCATION">Location</SelectItem>
                          <SelectItem value="GENRE">Genre</SelectItem>
                      </SelectContent>
                  </Select>
                  <div className="relative flex-1 w-full">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input aria-label="Search text box" placeholder={`Search ${searchType === 'ALL' ? 'series, creators, or characters' : searchType.toLowerCase()}...`} className="pl-9 h-10 sm:h-9 bg-background shadow-sm border-border w-full" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                  </div>
              </div>
              <div className="flex flex-row flex-wrap w-full lg:w-auto gap-3 items-center justify-between lg:justify-end">
                  <Select value={pageSize.toString()} onValueChange={handlePageSizeChange}>
                      <SelectTrigger aria-label="Change items per page" className="flex-1 lg:w-[130px] lg:flex-none h-10 sm:h-9 bg-background shadow-sm border-border">
                          <div className="flex items-center gap-2 truncate"><List className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Show 24" /></div>
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border">
                          <SelectItem value="12">Show 12</SelectItem>
                          <SelectItem value="24">Show 24</SelectItem>
                          <SelectItem value="48">Show 48</SelectItem>
                          <SelectItem value="96">Show 96</SelectItem>
                      </SelectContent>
                  </Select>
                  
                  <div className="flex items-center gap-1 border border-border rounded-md p-1 bg-background shadow-sm shrink-0">
                    <Button aria-label="Grid view mode" variant="ghost" size="icon" className={`h-8 w-8 sm:h-7 sm:w-7 transition-colors ${viewMode === 'grid' ? 'bg-primary/20 text-primary hover:bg-primary/30' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} onClick={() => toggleViewMode('grid')}>
                        <LayoutGrid className="w-4 h-4" />
                    </Button>
                    <Button aria-label="List view mode" variant="ghost" size="icon" className={`h-8 w-8 sm:h-7 sm:w-7 transition-colors ${viewMode === 'list' ? 'bg-primary/20 text-primary hover:bg-primary/30' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} onClick={() => toggleViewMode('list')}>
                        <List className="w-4 h-4" />
                    </Button>
                </div>
              </div>
          </div>

          <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-center w-full">
              <div className="flex gap-2 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 max-w-full">
                  <Button aria-label="Filter by favorite status" variant={showFavoritesOnly ? "default" : "outline"} className={`shrink-0 h-10 sm:h-9 font-bold shadow-sm ${showFavoritesOnly ? 'bg-primary hover:bg-primary/90 text-primary-foreground border-0' : 'bg-background border-border text-muted-foreground hover:text-primary'}`} onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}>
                      <Heart className={`w-4 h-4 ${showFavoritesOnly ? 'fill-current' : ''} sm:mr-2`} />
                      <span className="hidden sm:inline-block">Favorites</span>
                  </Button>
                  
                  <Button aria-label="Randomize library order" variant="outline" className="shrink-0 h-10 sm:h-9 shadow-sm bg-blue-600 hover:bg-blue-700 text-white border-0 px-3" onClick={handleSurpriseMe}>
                      <Dices className="w-4 h-4 sm:mr-2" />
                      <span className="hidden sm:inline font-bold">Surprise Me</span>
                  </Button>

                  {isAdmin && (
                      <Button aria-label="Filter monitored series" variant={monitoredFilter ? "default" : "outline"} className={`shrink-0 h-10 sm:h-9 font-bold shadow-sm ${monitoredFilter ? 'bg-primary hover:bg-primary/90 text-primary-foreground border-0' : 'bg-background border-border text-muted-foreground hover:text-primary'}`} onClick={() => setMonitoredFilter(!monitoredFilter)}>
                          <Activity className={`w-4 h-4 sm:mr-2`} />
                          <span className="hidden sm:inline-block">Monitored</span>
                      </Button>
                  )}
              </div>

              <div className="flex items-center gap-1 w-full sm:w-auto flex-1 sm:flex-none">
                  <Select value={activeCollection} onValueChange={setActiveCollection}>
                      <SelectTrigger aria-label="Filter by reading list" className={`w-full sm:w-[150px] h-10 sm:h-9 shadow-sm ${activeCollection !== "ALL" ? "bg-primary/10 text-primary border-primary/30 font-bold" : "bg-background border-border"}`}>
                          <div className="flex items-center gap-2 truncate"><Layers className="w-3 h-3 shrink-0"/> <SelectValue placeholder="Reading Lists" /></div>
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border">
                          <SelectItem value="ALL">All Comics</SelectItem>
                          {collections.length > 0 && <div className="border-t border-border my-1" />}
                          {collections.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      </SelectContent>
                  </Select>
                  <Button variant="outline" size="icon" className="h-10 w-10 sm:h-9 sm:w-9 shrink-0 bg-background border-border shadow-sm" onClick={() => setManageListsOpen(true)} title="Manage Lists" aria-label="Manage reading lists"><Settings2 className="w-4 h-4 text-muted-foreground" /></Button>
              </div>
              
              <Select value={readStatus} onValueChange={setReadStatus}>
                  <SelectTrigger aria-label="Filter by reading status" className="flex-1 sm:w-[150px] sm:flex-none h-10 sm:h-9 bg-background shadow-sm border-border">
                      <div className="flex items-center gap-2 truncate"><BookOpen className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Read Status" /></div>
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                      <SelectItem value="ALL">All Statuses</SelectItem>
                      <SelectItem value="UNREAD">Unread</SelectItem>
                      <SelectItem value="IN_PROGRESS">In Progress</SelectItem>
                      <SelectItem value="COMPLETED">Completed</SelectItem>
                  </SelectContent>
              </Select>

              <Select value={eraFilter} onValueChange={setEraFilter}>
                  <SelectTrigger aria-label="Filter by publication era" className="flex-1 sm:w-[130px] sm:flex-none h-10 sm:h-9 bg-background shadow-sm border-border">
                      <div className="flex items-center gap-2 truncate"><Clock className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Era" /></div>
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                      <SelectItem value="ALL">All Eras</SelectItem>
                      <SelectItem value="2020s">2020s</SelectItem>
                      <SelectItem value="2010s">2010s</SelectItem>
                      <SelectItem value="2000s">2000s</SelectItem>
                      <SelectItem value="1990s">1990s</SelectItem>
                      <SelectItem value="1980s">1980s</SelectItem>
                      <SelectItem value="CLASSIC">Pre-1980s</SelectItem>
                  </SelectContent>
              </Select>

              <Select value={publisherFilter} onValueChange={setPublisherFilter}>
                  <SelectTrigger aria-label="Filter by publisher" className="flex-1 sm:w-[150px] sm:flex-none h-10 sm:h-9 bg-background shadow-sm border-border">
                      <div className="flex items-center gap-2 truncate"><Filter className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Publisher" /></div>
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                      <SelectItem value="ALL">All Publishers</SelectItem>
                      {uniquePublishers.map(pub => (<SelectItem key={pub} value={pub}>{pub}</SelectItem>))}
                  </SelectContent>
              </Select>
              
              <Select value={sortOption} onValueChange={setSortOption}>
                  <SelectTrigger aria-label="Sort library results" className="flex-1 sm:w-[150px] sm:flex-none h-10 sm:h-9 bg-background shadow-sm border-border">
                      <div className="flex items-center gap-2 truncate"><SortAsc className="w-3 h-3 shrink-0 text-muted-foreground"/> <SelectValue placeholder="Sort By" /></div>
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                      <SelectItem value="alpha_asc">Title (A-Z)</SelectItem>
                      <SelectItem value="alpha_desc">Title (Z-A)</SelectItem>
                      <SelectItem value="year_desc">Release Year (Newest)</SelectItem>
                      <SelectItem value="year_asc">Release Year (Oldest)</SelectItem>
                      <SelectItem value="count_desc">Issue Count (High)</SelectItem>
                      <SelectItem value="random" className="text-blue-500 font-bold">Random</SelectItem>
                  </SelectContent>
              </Select>

              {hasActiveFilters && (
                  <Button aria-label="Clear all applied filters" variant="ghost" className="h-10 sm:h-9 text-muted-foreground hover:text-foreground px-3 flex-1 sm:flex-none" onClick={handleResetFilters}>
                      <X className="w-4 h-4 sm:mr-2" />
                      <span className="hidden sm:inline font-bold">Clear Filters</span>
                  </Button>
              )}

          </div>
      </div>

      {loading && page === 1 ? (
        <LibrarySkeleton count={pageSize} />
      ) : series.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground border-2 border-dashed rounded-lg border-border bg-muted/30">
          {activeCollection !== "ALL" ? (<><Layers className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>This reading list is currently empty.</p></>) : (<><Folder className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No comics found matching your criteria.</p></>)}
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 pb-10">
          {series.map((item: LibrarySeries) => {
              const unread = item.unreadCount !== undefined ? item.unreadCount : item.count;
              const isCompleted = unread === 0 && item.count > 0;
              const progress = item.progressPercentage || 0;
              const isSelected = selectedSeries.has(item.id);
              const navId = item.id || item.path;
              return (
                <div key={item.id || item.path} className="group flex flex-col space-y-2 relative">
                  <Card className={`aspect-[2/3] overflow-hidden shadow-sm transition-all p-0 relative flex flex-col ${isSelectionMode ? (isSelected ? 'border-4 border-primary scale-95' : 'border-2 border-border cursor-pointer') : 'border-border group-hover:shadow-md cursor-pointer bg-background'}`}>
                      {isSelectionMode && item.id && (<div className="absolute top-2 left-2 z-40 bg-black/50 backdrop-blur-sm rounded p-1 pointer-events-none">{isSelected ? <CheckSquare className="w-6 h-6 text-primary" /> : <Square className="w-6 h-6 text-white/80" />}</div>)}
                      
                      <div 
                          role="button"
                          tabIndex={0}
                          aria-label={`Open series: ${item.name}`}
                          className="relative flex-1 bg-muted flex items-center justify-center overflow-hidden focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                          onClick={(e) => { if (!isSelectionMode) handleNavigate(e as any, item.path, navId); else toggleSeriesSelection(item.id); }}
                          onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  if (!isSelectionMode) handleNavigate(e as any, item.path, navId); else toggleSeriesSelection(item.id);
                              }
                          }}
                      >
                          <ImageIcon className="w-8 h-8 text-muted-foreground/30 absolute z-0" />
                          {item.cover && (
                              <img 
                                src={item.cover} 
                                alt={`Cover art for ${item.name}`} 
                                loading="lazy" 
                                className={`object-cover w-full h-full relative z-10 transition-opacity ${isCompleted ? 'opacity-60' : ''}`} 
                                onError={(e) => { e.currentTarget.style.display = 'none'; }} 
                              />
                          )}
                          {!isSelectionMode && (
                              <div className="absolute top-1.5 left-1.5 flex flex-col gap-1 items-start z-30 pointer-events-none">
                                  {item.isPendingReq ? (
                                      <Badge className="bg-blue-500 hover:bg-blue-600 text-white border-0 shadow-sm px-1.5 h-4 text-[9px] font-black uppercase tracking-wider">Pending</Badge>
                                  ) : item.matchState === 'UNMATCHED' ? (
                                      <Badge className="bg-orange-500 hover:bg-orange-600 text-white border-0 shadow-sm px-1.5 h-4 text-[9px] font-black uppercase tracking-wider">Unmatched</Badge>
                                  ) : (
                                      <>
                                          {isCompleted ? (
                                              <Badge className="bg-green-600 hover:bg-green-600 text-white border-0 shadow-sm px-1.5 h-4 flex items-center gap-1 text-[9px] font-black uppercase tracking-wider"><Check className="w-2.5 h-2.5" /> Read</Badge>
                                          ) : unread > 0 ? (
                                              <Badge className="text-[9px] px-1.5 h-4 bg-primary hover:bg-primary/90 border-0 text-primary-foreground font-bold shadow-sm uppercase tracking-wider">{unread === item.count ? 'Unread' : `${unread} Left`}</Badge>
                                          ) : null}
                                          <Badge className="text-[9px] px-1.5 h-4 bg-black/70 hover:bg-black/70 border-0 text-white font-mono shadow-sm backdrop-blur-sm" title={`${item.count} total issues in this series`}>{item.count} {item.count === 1 ? 'Issue' : 'Issues'}</Badge>
                                      </>
                                  )}
                              </div>
                          )}
                          {!isSelectionMode && (
                              <div className="absolute top-1.5 right-1.5 z-30">
                                  <button aria-label={item.isFavorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.id, item.isFavorite); }} className={`h-8 w-8 sm:h-6 sm:w-6 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center transition-all ${item.isFavorite ? 'text-primary opacity-100' : 'text-white/70 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:text-primary'}`}>
                                      <Heart className={`w-4 h-4 sm:w-3.5 sm:h-3.5 ${item.isFavorite ? 'fill-current' : ''}`} />
                                  </button>
                              </div>
                          )}
                          {progress > 0 && !isCompleted && (<div className="absolute bottom-0 left-0 right-0 h-2.5 bg-black/80 z-10 border-t border-black/40"><div className="h-full bg-primary transition-all duration-500 shadow-sm shadow-primary/50" style={{ width: `${progress}%` }} /></div>)}
                      </div>

                        <div className={`absolute inset-0 bg-black/80 transition-opacity flex-col items-center justify-center gap-1.5 p-3 z-20 pointer-events-none group-hover:pointer-events-auto ${isSelectionMode ? 'hidden' : 'hidden md:flex opacity-0 group-hover:opacity-100'}`}>
                        <Button 
                            variant="default" 
                            size="sm" 
                            className="h-10 sm:h-8 w-full shadow-lg text-xs sm:text-[10px] font-bold bg-primary hover:bg-primary/90 text-primary-foreground border-0 min-w-0 px-2" 
                            onClick={(e) => handleNavigate(e as any, item.path, navId)}
                            aria-label={`Open reader for ${item.name}`}
                        >
                            {navigatingTo === navId ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin shrink-0" /> : <BookOpen className="w-3 h-3 mr-1.5 shrink-0" />} 
                            <span className="truncate">{navigatingTo === navId ? "Loading..." : "Read Series"}</span>
                        </Button>
                        <div className="flex gap-1.5 w-full">
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="h-10 sm:h-8 flex-1 shadow-lg font-bold px-1.5 min-w-0 flex items-center justify-center" 
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTargetSeries(item); }}
                            title="Add to List"
                            aria-label={`Add ${item.name} to a reading list`}
                        >
                            <ListPlus className="w-4 h-4 shrink-0" /> 
                        </Button>
                        {isAdmin && (
                            <Button 
                                variant="secondary" 
                                size="sm" 
                                className="h-10 sm:h-8 flex-1 shadow-lg font-bold px-1.5 min-w-0 flex items-center justify-center" 
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(item); }}
                                title="Edit Metadata"
                                aria-label={`Edit metadata for ${item.name}`}
                            >
                                <Settings2 className="w-4 h-4 shrink-0" /> 
                            </Button>
                            )}
                        </div>
                        {isAdmin && (
                            <Button aria-label={`Refresh cover art for ${item.name}`} variant="default" size="sm" className="h-10 sm:h-8 w-full shadow-lg text-xs sm:text-[10px] font-bold border-0 min-w-0 px-2" onClick={(e) => { e.preventDefault(); e.stopPropagation(); initiateRefreshMetadata(item.cvId, item.path); }}>
                                <RefreshCw className="w-3 h-3 mr-1.5 shrink-0" /> 
                                <span className="truncate">Fetch Cover</span>
                            </Button>
                        )}
                        {activeCollection !== "ALL" && (
                            <Button aria-label={`Remove ${item.name} from current list`} variant="destructive" size="sm" className="h-10 sm:h-8 w-full shadow-lg text-xs sm:text-[10px] font-bold min-w-0 px-2" onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveFromCollection(item.id); }}>
                                <Minus className="w-3 h-3 mr-1.5 shrink-0" /> 
                                <span className="truncate">Remove</span>
                            </Button>
                        )}
                      </div>
                  </Card>
                  <div 
                      className="px-0.5 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none rounded-sm" 
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { if (!isSelectionMode) handleNavigate(e as any, item.path, navId); }}
                      onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              if (!isSelectionMode) handleNavigate(e as any, item.path, navId);
                          }
                      }}
                  >
                      <div className="flex items-start justify-between gap-1 cursor-pointer hover:underline">
                          <h3 className={`text-[12px] sm:text-[11px] font-bold truncate leading-tight ${isCompleted ? 'text-muted-foreground' : 'text-foreground'}`} title={item.name}>{item.name}</h3>
                      </div>
                      <p className="text-[10px] sm:text-[9px] text-muted-foreground mt-0.5 truncate" title={item.publisher || 'Unknown'}>{item.publisher || 'Unknown'} • {item.year || '????'}</p>
                  </div>
                </div>
              )
          })}
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden bg-background pb-0 mb-10">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
                <tr>{isSelectionMode && <th className="w-12 px-4 py-3 text-center">Select</th>}<th className="w-16 px-4 py-3 text-center">Cover</th><th className="px-4 py-3">Series Name</th><th className="px-4 py-3 hidden md:table-cell">Publisher</th><th className="px-4 py-3 hidden sm:table-cell text-center">Year</th><th className="px-4 py-3 text-center">Issues</th>{!isSelectionMode && <th className="px-4 py-3 text-right">Actions</th>}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {series.map((item: LibrarySeries) => {
                  const unread = item.unreadCount !== undefined ? item.unreadCount : item.count;
                  const isCompleted = unread === 0 && item.count > 0;
                  const isSelected = selectedSeries.has(item.id);
                  const navId = item.id || item.path;
                  return (
                    <tr 
                        key={item.id || item.path} 
                        className={`transition-colors group ${isSelectionMode ? 'cursor-pointer hover:bg-muted ' + (isSelected ? 'bg-primary/10' : '') : 'hover:bg-muted/50'}`} 
                        onClick={() => isSelectionMode && item.id && toggleSeriesSelection(item.id)}
                    >
                        {isSelectionMode && (<td className="px-4 py-3 text-center">{isSelected ? <CheckSquare className="w-6 h-6 text-primary mx-auto" aria-label="Selected" /> : <Square className="w-6 h-6 text-muted-foreground mx-auto" aria-label="Not selected" />}</td>)}
                        
                        <td className="px-4 py-2">
                            <div 
                                className="w-10 h-14 bg-muted rounded overflow-hidden flex items-center justify-center shrink-0 border border-border relative focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                                role="button"
                                tabIndex={0}
                                aria-label={`Open series: ${item.name}`}
                                onClick={(e) => { if(!isSelectionMode) handleNavigate(e as any, item.path, navId); }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        if (!isSelectionMode) handleNavigate(e as any, item.path, navId);
                                    }
                                }}
                            >
                                <ImageIcon className="w-4 h-4 text-muted-foreground/50 absolute z-0" />
                                {item.cover && (
                                    <img 
                                      src={item.cover} 
                                      alt={`Cover art for ${item.name}`} 
                                      loading="lazy" 
                                      className={`w-full h-full object-cover relative z-10 transition-opacity ${isCompleted ? 'opacity-60' : ''}`} 
                                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                    />
                                )}
                                {isCompleted && (<div className="absolute inset-0 flex items-center justify-center bg-green-500/20 z-20"><Check className="w-4 h-4 text-green-500 font-bold"/></div>)}
                            </div>
                        </td>
                        <td className={`px-4 py-3 font-bold ${isCompleted ? 'text-muted-foreground' : 'text-foreground'}`}>
                            <div className="flex items-center gap-2">
                                {isSelectionMode ? (<span>{item.name}</span>) : (
                                    <button 
                                        onClick={(e) => handleNavigate(e as any, item.path, navId)} 
                                        className="hover:text-primary transition-colors text-left font-bold flex items-center gap-2 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none rounded-sm"
                                        title={item.name}
                                    >
                                        {item.name}
                                        {navigatingTo === navId && <Loader2 className="w-3 h-3 animate-spin text-primary" />}
                                    </button>
                                )}
                                {!isSelectionMode && (<button aria-label={item.isFavorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.id, item.isFavorite); }} className={`transition-colors focus:outline-none p-2 -m-2 ${item.isFavorite ? 'text-primary' : 'text-muted-foreground/50 hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}`}><Heart className={`w-4 h-4 sm:w-3.5 sm:h-3.5 ${item.isFavorite ? 'fill-current' : ''}`} /></button>)}
                            </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell" title={item.publisher || 'Unknown'}>{item.publisher || 'Unknown'}</td>
                        <td className="px-4 py-3 text-center hidden sm:table-cell">{item.year || '????'}</td>
                        <td className="px-4 py-3 text-center">
                            {item.isPendingReq ? (
                                <Badge className="bg-blue-500 hover:bg-blue-600 text-white border-0 text-[9px] px-1.5 h-4 uppercase tracking-wider">Pending</Badge>
                            ) : item.matchState === 'UNMATCHED' ? (
                                <Badge className="bg-orange-500 hover:bg-orange-600 text-white border-0 text-[9px] px-1.5 h-4 uppercase tracking-wider">Unmatched</Badge>
                            ) : (
                                <div className="flex items-center justify-center gap-2">
                                    <Badge variant="secondary" className="font-mono bg-muted border-border" title={`${item.count} total issues in this series`}>{item.count}</Badge>
                                    {unread > 0 && !isCompleted && (
                                        <Badge className="bg-primary/20 text-primary border-0 font-bold uppercase tracking-wider text-[10px]">{unread === item.count ? 'Unread' : `${unread} Left`}</Badge>
                                    )}
                                </div>
                            )}
                        </td>
                        {!isSelectionMode && (
                            <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                    <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:text-primary hover:bg-primary/10" title="Add to List" aria-label={`Add ${item.name} to a reading list`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTargetSeries(item); }}> <ListPlus className="w-5 h-5 sm:w-4 sm:h-4" /> </Button> 
                                    {activeCollection !== "ALL" && (<Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" title="Remove from List" aria-label={`Remove ${item.name} from current reading list`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveFromCollection(item.id); }}> <Minus className="w-5 h-5 sm:w-4 sm:h-4" /> </Button>)} 
                                    <Button aria-label={`Edit metadata for ${item.name}`} variant="ghost" size="icon" className="hidden sm:inline-flex h-8 w-8 hover:bg-muted" title="Edit Metadata" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(item); }}> <Settings2 className="w-4 h-4 text-muted-foreground" /> </Button>
                                    <Button 
                                        variant="ghost" 
                                        size="icon" 
                                        className="h-10 w-10 sm:h-8 sm:w-8 hover:text-primary hover:bg-primary/10"
                                        title="Read Series"
                                        aria-label={`Open reader for ${item.name}`}
                                        onClick={(e) => handleNavigate(e as any, item.path, navId)}
                                    > 
                                        {navigatingTo === navId ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin text-primary" /> : <BookOpen className="w-5 h-5 sm:w-4 sm:h-4" />}
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

      {hasMore && !isSelectionMode && (
          <div ref={lastElementRef} className="flex justify-center pt-8 pb-12 w-full">
              {loadingMore ? (
                  <div className="flex items-center text-muted-foreground font-medium bg-muted/50 px-4 py-2 rounded-full border border-border shadow-sm">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading more...
                  </div>
              ) : (
                  <div className="h-10 w-full" /> 
              )}
          </div>
      )}

      {isSelectionMode && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-background text-foreground px-4 sm:px-6 py-3 rounded-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.5)] flex items-center gap-3 sm:gap-4 z-50 animate-in slide-in-from-bottom-8 border border-border w-[95%] sm:w-auto overflow-x-auto">
              <Button variant="ghost" size="sm" className="h-10 sm:h-8 shrink-0 hover:bg-muted text-muted-foreground font-medium" onClick={toggleSelectAll}>
                  {selectedSeries.size === series.length && series.length > 0 ? "Deselect All" : "Select All"}
              </Button>
              <div className="h-5 w-px bg-border shrink-0" />
              <span aria-live="polite" className="font-black whitespace-nowrap min-w-[60px] sm:min-w-[100px] text-center text-sm sm:text-base shrink-0">{selectedSeries.size} Selected</span>
              
              <div className="flex gap-2 shrink-0">
                <Button aria-label="Mark selected series as unread" size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedSeries.size > 0 ? 'text-primary hover:bg-muted border-primary/50' : 'bg-muted text-muted-foreground cursor-not-allowed border-border'}`} disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => handleBulkProgress('UNREAD')}>
                    <EyeOff className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Mark Unread</span>
                </Button>
                
                <Button aria-label="Add selected series to a reading list" size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedSeries.size > 0 ? 'text-primary hover:bg-muted border-primary/50' : 'bg-muted text-muted-foreground cursor-not-allowed border-border'}`} disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => setBulkListModalOpen(true)}>
                    <ListPlus className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Add to List</span>
                </Button>

                {activeCollection !== "ALL" && (
                    <Button aria-label="Remove selected series from current list" size="sm" variant="destructive" className="h-10 sm:h-8 shadow-sm font-bold ml-1 sm:ml-2 transition-all" disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => handleBulkAdvanced('bulk-remove-list', activeCollection)}>
                        <Minus className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Remove</span>
                    </Button>
                )}

                {isAdmin && (
                  <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                          <Button aria-label="Bulk actions menu" size="sm" variant="outline" disabled={selectedSeries.size === 0 || isBulkProcessing} className="h-10 sm:h-8 shadow-sm font-bold bg-background border-border ml-1 sm:ml-2">
                              <MoreHorizontal className="w-4 h-4" />
                          </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64 bg-popover border-border z-[100]">
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-monitor', 'MONITOR')} className="cursor-pointer font-medium h-10 sm:h-8 hover:bg-muted">
                              <Activity className="w-4 h-4 mr-2 text-primary" /> Monitor Series
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-monitor', 'UNMONITOR')} className="cursor-pointer font-medium text-muted-foreground h-10 sm:h-8 hover:bg-muted">
                              <EyeOff className="w-4 h-4 mr-2" /> Stop Monitoring
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="bg-border" />
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-manga', 'MANGA')} className="cursor-pointer font-medium h-10 sm:h-8 hover:bg-muted">
                              <ArrowRightLeft className="w-4 h-4 mr-2 text-purple-500" /> Move to Manga
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleBulkAdvanced('bulk-manga', 'COMIC')} className="cursor-pointer font-medium h-10 sm:h-8 hover:bg-muted">
                              <ArrowRightLeft className="w-4 h-4 mr-2 text-green-500" /> Move to Comics
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="bg-border" />
                          <DropdownMenuItem onClick={() => setRenameModalOpen(true)} className="cursor-pointer font-medium h-10 sm:h-8 hover:bg-muted">
                              <FileEdit className="w-4 h-4 mr-2 text-indigo-500" /> Standardize File Names
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setRepackModalOpen(true)} className="cursor-pointer font-medium h-10 sm:h-8 hover:bg-muted">
                              <Layers className="w-4 h-4 mr-2 text-teal-500" /> Standardize Internal Pages
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={handleBulkRefresh} className="cursor-pointer font-medium h-10 sm:h-8 hover:bg-muted">
                              <RefreshCw className="w-4 h-4 mr-2 text-orange-500" /> Refresh Metadata
                          </DropdownMenuItem>
                      </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {isAdmin && (
                  <Button aria-label="Delete selected series" size="sm" className={`h-10 sm:h-8 shadow-sm font-bold ml-1 sm:ml-2 transition-all ${selectedSeries.size > 0 ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-muted text-muted-foreground cursor-not-allowed'}`} disabled={selectedSeries.size === 0 || isBulkProcessing} onClick={() => setBulkDeleteModalOpen(true)}>
                      <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
          </div>
      )}

      {/* MANAGE LISTS MODAL */}
      <Dialog open={manageListsOpen} onOpenChange={setManageListsOpen}>
        <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl">
          <DialogHeader>
            <DialogTitle>Manage Reading Lists</DialogTitle>
            <DialogDescription>View and delete your custom collections.</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {collections.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6 border-2 border-dashed border-border rounded-lg">You haven't created any lists yet.</p>
            ) : (
                collections.map(c => (
                    <div key={c.id} className="flex items-center justify-between bg-muted/50 p-3 rounded-lg border border-border">
                        <div>
                            <p className="font-bold text-sm text-foreground">{c.name}</p>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mt-0.5">{c.items?.length || 0} Items</p>
                        </div>
                        <Button aria-label={`Delete list: ${c.name}`} variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setCollectionToDelete(c.id)}>
                            <Trash2 className="w-4 h-4" />
                        </Button>
                    </div>
                ))
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0"><Button onClick={() => setManageListsOpen(false)} variant="outline" className="w-full sm:w-auto h-12 sm:h-10 border-border hover:bg-muted">Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* NEW BULK LIST MODAL */}
      <Dialog open={bulkListModalOpen} onOpenChange={setBulkListModalOpen}>
        <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl">
          <DialogHeader>
            <DialogTitle>Add to Reading List</DialogTitle>
            <DialogDescription>Add <strong>{selectedSeries.size} selected series</strong> to a collection to organize your library.</DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-col-select">Select Existing List</Label>
              <Select value={selectedCollectionId} onValueChange={(v) => { setSelectedCollectionId(v); setNewCollectionName(""); }}>
                <SelectTrigger id="bulk-col-select" className="bg-background border-border h-12 sm:h-10"><SelectValue placeholder="Choose a list..." /></SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  {collections.length === 0 && <SelectItem value="none" disabled>No lists available</SelectItem>}
                  {collections.map(c => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-new-list-input">Or Create New List</Label>
              <Input id="bulk-new-list-input" placeholder="e.g. Webtoons, Marvel Events, Mature..." value={newCollectionName} className="bg-background h-12 sm:h-10 border-border" onChange={e => {setNewCollectionName(e.target.value); setSelectedCollectionId("");}} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" onClick={() => setBulkListModalOpen(false)} disabled={addingToList} className="h-12 sm:h-10 w-full sm:w-auto border-border hover:bg-muted">Cancel</Button><Button onClick={submitBulkAddToCollection} disabled={addingToList || (!selectedCollectionId && !newCollectionName.trim())} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold w-full h-12 sm:h-10">{addingToList ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <ListPlus className="w-5 h-5 mr-2" />} Save to List</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* RENAME FILES MODAL */}
      <Dialog open={renameModalOpen} onOpenChange={setRenameModalOpen}>
          <DialogContent className="sm:max-w-[700px] w-[95%] bg-background border-border rounded-xl">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                      <FolderSearch className="w-5 h-5 text-primary" /> Standardize File Names
                  </DialogTitle>
                  <DialogDescription>
                      This will physically move and rename the files on your hard drive for all <strong>{selectedSeries.size}</strong> selected series.
                  </DialogDescription>
              </DialogHeader>
              
              <div className="py-4 space-y-6">
                  {/* Dropdowns replaced with Inputs */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Series Folder Format</Label>
                          <Input 
                              value={folderPattern} 
                              onChange={(e) => setFolderPattern(e.target.value)}
                              className="bg-background border-border h-12 sm:h-10 font-mono text-sm"
                          />
                      </div>

                      <div className="space-y-2">
                          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">File Naming Convention</Label>
                          <Input 
                              value={filePattern} 
                              onChange={(e) => setFilePattern(e.target.value)}
                              className="bg-background border-border h-12 sm:h-10 font-mono text-sm"
                          />
                      </div>
                  </div>

                  {/* Real-time Preview Table */}
                  <div className="space-y-2">
                      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Path Preview (Sample from Selected Series)</Label>
                      <div className="border border-border rounded-lg overflow-hidden bg-muted/20">
                          {isLoadingPreview ? (
                              <div className="flex flex-col items-center justify-center p-8 text-muted-foreground">
                                  <Loader2 className="w-6 h-6 animate-spin mb-2" />
                                  <span className="text-sm font-medium">Generating cross-series preview...</span>
                              </div>
                          ) : renamePreviews.length === 0 ? (
                              <div className="p-8 text-center text-sm text-muted-foreground italic">
                                  No downloaded files found across the selected series.
                              </div>
                          ) : (
                              <div className="max-h-[300px] overflow-y-auto">
                                  <table className="w-full text-xs text-left">
                                      <thead className="bg-muted sticky top-0 border-b border-border shadow-sm z-10">
                                          <tr>
                                              <th className="px-3 py-2 font-semibold">Series</th>
                                              <th className="px-3 py-2 font-semibold">Current Path</th>
                                              <th className="px-3 py-2 font-semibold text-primary">New Path</th>
                                          </tr>
                                      </thead>
                                      <tbody className="divide-y divide-border/50">
                                          {renamePreviews.map((preview, i) => (
                                              <tr key={i} className="hover:bg-muted/30 transition-colors">
                                                  <td className="px-3 py-2 font-bold text-foreground align-top max-w-[100px] truncate" title={preview.seriesName}>
                                                      {preview.seriesName}
                                                  </td>
                                                  <td className="px-3 py-2 text-red-500/80 break-all font-mono align-top">
                                                      {preview.oldPath}
                                                  </td>
                                                  <td className="px-3 py-2 text-green-500/90 break-all font-mono font-medium align-top">
                                                      {preview.newPath}
                                                  </td>
                                              </tr>
                                          ))}
                                      </tbody>
                                  </table>
                              </div>
                          )}
                      </div>
                  </div>
              </div>

              <DialogFooter className="flex gap-2 sm:gap-2">
                  <Button variant="outline" onClick={() => setRenameModalOpen(false)} disabled={isBulkProcessing} className="h-12 sm:h-10 border-border hover:bg-muted">Cancel</Button>
                  <Button className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold h-12 sm:h-10" onClick={handleBulkRename} disabled={isBulkProcessing || isLoadingPreview || renamePreviews.length === 0}>
                      {isBulkProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <FolderSearch className="w-5 h-5 mr-2" />} Standardize Selected
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* INTERNAL PAGE REPACKER MODAL */}
      <Dialog open={repackModalOpen} onOpenChange={setRepackModalOpen}>
          <DialogContent className="sm:max-w-[450px] w-[95%] bg-background border-border rounded-xl">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><Layers className="w-5 h-5 text-teal-500"/> Standardize Internal Pages</DialogTitle>
                  <DialogDescription className="pt-2">
                      This will extract all issues in the <strong>{selectedSeries.size}</strong> selected series, rename the internal image files sequentially (e.g. <code>page_0001.jpg</code>), and repack them into clean <code>.cbz</code> files.
                      <br/><br/>
                      <strong className="text-foreground">Note:</strong> This process is CPU/disk intensive and will run in the background. Check System Logs for progress.
                  </DialogDescription>
              </DialogHeader>
              <DialogFooter className="flex gap-2 sm:gap-2">
                  <Button variant="outline" onClick={() => setRepackModalOpen(false)} disabled={isBulkProcessing} className="h-12 sm:h-10 border-border hover:bg-muted">Cancel</Button>
                  <Button className="bg-teal-600 hover:bg-teal-700 text-white font-bold h-12 sm:h-10" onClick={handleBulkRepack} disabled={isBulkProcessing}>
                      {isBulkProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Layers className="w-5 h-5 mr-2" />} Start Repacking
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={bulkDeleteModalOpen} onOpenChange={setBulkDeleteModalOpen}>
          <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl">
              <DialogHeader><DialogTitle className="text-red-600 flex items-center gap-2"><Trash2 className="w-5 h-5"/> Delete {selectedSeries.size} Series?</DialogTitle><DialogDescription className="pt-2">You are about to remove <strong>{selectedSeries.size}</strong> series from your library database.</DialogDescription></DialogHeader>
              <div className="py-4"><div className="flex items-center space-x-2 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-900/50"><Switch id="bulk-delete-files" checked={bulkDeleteFiles} onCheckedChange={setBulkDeleteFiles} /><Label htmlFor="bulk-delete-files" className="text-sm font-semibold text-red-800 dark:text-red-400 cursor-pointer">Also delete physical folders and files from disk</Label></div></div>
              <DialogFooter className="flex gap-2 sm:gap-0"><Button variant="outline" onClick={() => setBulkDeleteModalOpen(false)} disabled={isBulkProcessing} className="h-12 sm:h-10 border-border hover:bg-muted">Cancel</Button><Button variant="destructive" onClick={handleBulkDelete} disabled={isBulkProcessing} className="h-12 sm:h-10">{isBulkProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Trash2 className="w-5 h-5 mr-2" />} Delete All</Button></DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={!!targetSeries} onOpenChange={(open) => !open && setTargetSeries(null)}>
        <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl">
          <DialogHeader><DialogTitle>Add to Reading List</DialogTitle><DialogDescription>Add <strong className="text-primary">{targetSeries?.name}</strong> to a collection.</DialogDescription></DialogHeader>
          <div className="space-y-6 py-4">
              <div className="space-y-2"><Label htmlFor="col-select-single">Select Existing List</Label><Select value={selectedCollectionId} onValueChange={(v) => { setSelectedCollectionId(v); setNewCollectionName(""); }}><SelectTrigger id="col-select-single" className="bg-background border-border h-12 sm:h-10"><SelectValue placeholder="Choose a list..." /></SelectTrigger><SelectContent className="bg-popover border-border">{collections.length === 0 && <SelectItem value="none" disabled>No lists available</SelectItem>}{collections.map(c => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}</SelectContent></Select></div>
              <div className="space-y-2"><Label htmlFor="col-input-single">Create New List</Label><Input id="col-input-single" placeholder="e.g. Marvel Events" value={newCollectionName} className="bg-background border-border h-12 sm:h-10" onChange={e => {setNewCollectionName(e.target.value); setSelectedCollectionId("");}} /></div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" onClick={() => setTargetSeries(null)} disabled={addingToList} className="h-12 sm:h-10 w-full sm:w-auto border-border hover:bg-muted">Cancel</Button><Button onClick={submitAddToCollection} disabled={addingToList || (!selectedCollectionId && !newCollectionName.trim())} className="h-12 sm:h-10 w-full sm:w-auto font-bold bg-primary hover:bg-primary/90 text-primary-foreground">{addingToList ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null} Save to List</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={!!editing} onOpenChange={() => !updating && setEditing(null)}>
        <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Edit Metadata</DialogTitle></DialogHeader>
            {editing && (
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label htmlFor="path-copy">Source Folder Path</Label>
                        <div className="flex gap-2">
                            <Input id="path-copy" readOnly value={editing.path || ""} className="bg-muted text-xs truncate border-border text-muted-foreground h-12 sm:h-10" />
                            <Button aria-label="Copy folder path to clipboard" variant="secondary" size="icon" onClick={copyToClipboard} type="button" className="shrink-0 h-12 w-12 sm:h-10 sm:w-10 hover:bg-muted border border-border">{copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5 text-muted-foreground" />}</Button>
                        </div>
                    </div>
                    <div className="grid gap-2"><Label htmlFor="cvId">ComicVine ID</Label><Input id="cvId" type="number" value={editing.cvId || ""} onChange={e => setEditing({...editing, cvId: e.target.value ? parseInt(e.target.value) : undefined})} className="bg-background border-border h-12 sm:h-10 text-lg" /></div>
                    <div className="grid gap-2"><Label htmlFor="publisher">Publisher</Label><Input id="publisher" value={editing.publisher || ""} onChange={e => setEditing({...editing, publisher: e.target.value})} className="bg-background border-border h-12 sm:h-10" /></div>
                    <div className="grid gap-2"><Label htmlFor="name">Series Name</Label><Input id="name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} className="bg-background border-border h-12 sm:h-10" /></div>
                    <div className="grid gap-2"><Label htmlFor="year">Year</Label><Input id="year" type="number" value={editing.year || ""} onChange={e => setEditing({...editing, year: e.target.value})} className="bg-background border-border h-12 sm:h-10" /></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                        <div className="flex items-center gap-2 bg-muted p-3 rounded-lg border border-border"><Switch id="monitor-switch" checked={editing.monitored || false} onCheckedChange={v => setEditing({...editing, monitored: v})} /><Label htmlFor="monitor-switch" className="cursor-pointer">Monitor Series</Label></div>
                        <div className="flex items-center gap-2 bg-muted p-3 rounded-lg border border-border"><Switch id="manga-switch" checked={editing.isManga || false} onCheckedChange={v => setEditing({...editing, isManga: v})} /><Label htmlFor="manga-switch" className="cursor-pointer">Flag as Manga</Label></div>
                    </div>
                </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" onClick={() => setEditing(null)} disabled={updating} className="h-12 sm:h-10 w-full sm:w-auto border-border hover:bg-muted">Cancel</Button><Button onClick={handleUpdateMetadata} disabled={updating} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold h-12 sm:h-10 w-full sm:w-auto">{updating ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null} Save Changes</Button></DialogFooter>
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

export default function LibraryPage() {
  return (
    <Suspense fallback={<LibrarySkeleton />}>
      <LibraryContent />
    </Suspense>
  )
}