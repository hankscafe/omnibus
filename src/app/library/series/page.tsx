// src/app/library/series/page.tsx
"use client"

import { useState, useEffect, useTransition, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { 
  ChevronLeft, BookOpen, Layers, Loader2, Image as ImageIcon, 
  Info, Calendar, PenTool, Paintbrush, Download, ExternalLink, 
  RefreshCw, Search, Edit, Copy, Check, CloudDownload, CloudOff, Heart, Trash2,
  CheckCircle2, DownloadCloud, Users, Sparkles, AlertTriangle,
  LayoutGrid, List 
} from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

function SeriesDetailSkeleton() {
  return (
    <div className="animate-pulse space-y-8">
      <div className="space-y-3">
        <div className="h-9 w-64 bg-slate-200 dark:bg-slate-800 rounded" />
        <div className="flex gap-3">
          <div className="h-5 w-20 bg-slate-200 dark:bg-slate-800 rounded-full" />
          <div className="h-5 w-32 bg-slate-200 dark:bg-slate-800 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-10">
        <div className="aspect-[2/3] w-full bg-slate-200 dark:bg-slate-800 rounded-2xl" />
        <div className="space-y-6">
          <div className="h-40 w-full bg-slate-200 dark:bg-slate-800 rounded-2xl" />
          <div className="h-60 w-full bg-slate-200 dark:bg-slate-800 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

function SeriesContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  const folderPath = searchParams.get('path');
  
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const [downloadedIssues, setDownloadedIssues] = useState<any[]>([]);
  const [missingIssues, setMissingIssues] = useState<any[]>([]);
  const [activeIssue, setActiveIssue] = useState<any>(null);
  
  const [seriesInfo, setSeriesInfo] = useState<{name: string, cover: string | null, cvId: number | null, path: string | null, id: string | null, isFavorite: boolean, publisher: string | null, year: string | null, description: string | null, status: string | null, monitored: boolean}>({ 
    name: "", cover: null, cvId: null, path: null, id: null, isFavorite: false, publisher: null, year: null, description: null, status: null, monitored: false
  });
  
  const [copied, setCopied] = useState(false);
  const [isRefreshingMetadata, setIsRefreshingMetadata] = useState(false);

  const [matchModalOpen, setMatchModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreSearch, setHasMoreSearch] = useState(false);
  const [isSearchingMore, setIsSearchingMore] = useState(false);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState<any>({ name: "", publisher: "", year: "", cvId: "", monitored: false, isManga: false });
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportDescription, setReportDescription] = useState("");
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);

  const [requestingIds, setRequestingIds] = useState<Set<number>>(new Set());
  const [requestedIds, setRequestedIds] = useState<Set<number>>(new Set());

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);

  const [deleteIssueModalOpen, setDeleteIssueModalOpen] = useState(false);
  const [issueToDelete, setIssueToDelete] = useState<any>(null);
  const [deleteIssueFile, setDeleteIssueFile] = useState(false);
  const [isDeletingIssue, setIsDeletingIssue] = useState(false);

  const { toast } = useToast();

  const isAdmin = session?.user?.role === 'ADMIN';
  const canDownload = isAdmin || (session?.user as any)?.canDownload;

  useEffect(() => {
    document.title = "Omnibus - Series";
    const savedView = localStorage.getItem('omnibus-series-view') as 'grid' | 'list';
    if (savedView === 'grid' || savedView === 'list') setViewMode(savedView);
  }, [loading]);

  const toggleViewMode = (mode: 'grid' | 'list') => {
      setViewMode(mode);
      localStorage.setItem('omnibus-series-view', mode);
  };

  useEffect(() => {
    if (!folderPath) return;
    setLoading(true);
    
    fetch(`/api/library/series?path=${encodeURIComponent(folderPath)}&t=${Date.now()}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) throw new Error(data.error);
            setDownloadedIssues(data.downloadedIssues || []);
            setMissingIssues(data.missingIssues || []);
            
            setSeriesInfo({ 
                name: data.seriesName || data.name || "Unknown Series", 
                cover: data.coverUrl, 
                cvId: data.cvId,
                path: data.path || folderPath,
                id: data.id || null, 
                isFavorite: data.isFavorite || false,
                publisher: data.publisher || null, 
                year: data.year ? data.year.toString() : null,
                description: data.description || null,
                status: data.status || null,
                monitored: data.monitored || false
            });
            
            // Populates the existing Edit Info switches
            setEditForm({
                name: data.seriesName || data.name || "",
                publisher: data.publisher || "", 
                year: data.year ? data.year.toString() : "",
                cvId: data.cvId ? data.cvId.toString() : "",
                monitored: data.monitored || false,
                isManga: data.isManga || false
            });

            const current = data.downloadedIssues.find((i: any) => !i.isRead && i.readProgress < 100) || data.downloadedIssues[0];
            setActiveIssue(current);
        })
        .catch(e => { console.error("Scan Failed:", e.message); })
        .finally(() => setLoading(false));
  }, [folderPath]);

  useEffect(() => {
    if (!activeIssue?.id) return;
    
    let isMounted = true;
    
    fetch(`/api/library/issue?id=${activeIssue.id}`)
        .then(res => res.json())
        .then(data => {
            if (isMounted && !data.error) {
                setActiveIssue((prev: any) => ({
                    ...prev,
                    writers: data.writers?.length > 0 ? data.writers : prev.writers,
                    artists: data.artists?.length > 0 ? data.artists : prev.artists,
                    characters: data.characters?.length > 0 ? data.characters : prev.characters,
                    description: data.description || prev.description
                }));
            }
        })
        .catch(() => {});
        
    return () => { isMounted = false; };
  }, [activeIssue?.id]);

  const runAutoDeepScan = async (cvId: string, currentPath: string) => {
      setIsRefreshingMetadata(true);
      
      setTimeout(() => {
          toast({ 
              title: "Downloading Deep Metadata", 
              description: "Fetching writers, artists, and synopsis in the background..." 
          });
      }, 100);

      try {
          const res = await fetch('/api/library/refresh-metadata', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cvId: parseInt(cvId), folderPath: currentPath })
          });
          
          if (res.ok) {
              toast({ 
                  title: "Metadata Complete!", 
                  description: "Refreshing page with new data..." 
              });
              
              setTimeout(() => {
                  window.location.reload(); 
              }, 1500);
          }
      } catch (e) {
          console.error(e);
      } finally {
          setIsRefreshingMetadata(false);
      }
  };

  useEffect(() => {
    const autoSync = searchParams.get('autoSync');
    if (autoSync && folderPath && !loading) {
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('autoSync');
        window.history.replaceState({}, '', newUrl.toString());
        runAutoDeepScan(autoSync, folderPath);
    }
  }, [searchParams, folderPath, loading]);

  const writers = activeIssue?.writers || [];
  const artists = activeIssue?.artists || [];
  const characters = activeIssue?.characters || [];
  const displayDescription = activeIssue?.description || seriesInfo.description || "No synopsis available.";
  const displayCover = activeIssue?.coverUrl || seriesInfo.cover;
  const hasCreators = writers.length > 0 || artists.length > 0;

  const handleRefreshMetadata = async () => {
    if (!seriesInfo.cvId) return;
    setIsRefreshingMetadata(true);
    toast({ title: "Syncing with ComicVine", description: "Downloading issues, credits, and synopsis. This may take a few seconds..." });
    
    try {
        const res = await fetch('/api/library/refresh-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cvId: seriesInfo.cvId, folderPath: folderPath })
        });
        
        if (res.ok) {
            toast({ title: "Success", description: "Metadata successfully stored in your database!" });
            window.location.href = window.location.href; 
        } else {
            const err = await res.json();
            toast({ title: "Refresh Failed", description: err.error, variant: "destructive" });
        }
    } catch (e: any) {
        toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
        setIsRefreshingMetadata(false);
    }
  }

  const handleRequestMissing = async (issue: any) => {
      setRequestingIds(prev => new Set(prev).add(issue.id));
      try {
          const res = await fetch('/api/request', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  type: 'issue',
                  cvId: seriesInfo.cvId, 
                  name: `${seriesInfo.name} #${issue.parsedNum}`, 
                  year: seriesInfo.year || new Date().getFullYear().toString(),
                  publisher: seriesInfo.publisher || "Unknown",
                  image: issue.coverUrl || seriesInfo.cover 
              })
          });
          if (res.ok) {
              setRequestedIds(prev => new Set(prev).add(issue.id));
              return true;
          }
          return false;
      } catch (error: any) {
          return false;
      } finally {
          setRequestingIds(prev => {
              const next = new Set(prev);
              next.delete(issue.id);
              return next;
          });
      }
  }

  const handleDownloadAllMissing = async () => {
    if (missingIssues.length === 0) return;
    setIsBulkDownloading(true);
    toast({ title: "Bulk Request Started", description: `Queuing ${missingIssues.length} issues...` });
    
    let successCount = 0;
    for (const issue of missingIssues) {
      const success = await handleRequestMissing(issue);
      if (success) successCount++;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    toast({ 
      title: "Bulk Request Complete", 
      description: `Successfully queued ${successCount} of ${missingIssues.length} missing issues.` 
    });
    setIsBulkDownloading(false);
  }

  const toggleFavorite = async () => {
    if (!seriesInfo.id) return;
    const currentStatus = seriesInfo.isFavorite;
    setSeriesInfo(prev => ({ ...prev, isFavorite: !currentStatus }));
    try {
        await fetch('/api/library/favorite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seriesId: seriesInfo.id })
        });
    } catch (e) {
        setSeriesInfo(prev => ({ ...prev, isFavorite: currentStatus })); 
        toast({ title: "Error", description: "Failed to update favorites.", variant: "destructive" });
    }
  };

  const copyToClipboard = () => {
    if (seriesInfo.path) {
      navigator.clipboard.writeText(seriesInfo.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Path Copied" });
    }
  };

  const performSearch = async (e?: React.FormEvent, isLoadMore = false) => {
      if (e) e.preventDefault();
      if (searchQuery.trim().length < 2) return;

      const nextPage = isLoadMore ? searchPage + 1 : 1;

      if (!isLoadMore) {
          setIsSearching(true);
      } else {
          setIsSearchingMore(true);
      }

      try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&page=${nextPage}`);
          const data = await res.json();
          
          if (isLoadMore) {
              setSearchResults(prev => [...prev, ...(data.results || [])]);
          } else {
              setSearchResults(data.results || []);
          }
          
          setHasMoreSearch(data.hasMore || false);
          setSearchPage(nextPage);
      } catch (e) {
          toast({ title: "Search failed", variant: "destructive" });
      } finally {
          setIsSearching(false);
          setIsSearchingMore(false);
      }
  }

  const handleMatch = async (item: any) => {
      setIsMatching(true);
      try {
          const safeYear = item.start_year || (item.year ? item.year.toString() : new Date().getFullYear().toString());
          let safePublisher = "Unknown";
          if (item.publisher) {
              if (typeof item.publisher === 'object' && item.publisher.name) safePublisher = item.publisher.name;
              else if (typeof item.publisher === 'string') safePublisher = item.publisher;
          }
          const res = await fetch('/api/library/match-series', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  oldFolderPath: folderPath,
                  cvId: parseInt(item.id) || item.id,
                  name: item.name || "Unknown",
                  year: safeYear,
                  publisher: safePublisher
              })
          });
          const data = await res.json();
          if (data.success) {
              toast({ title: "Series Matched!" });
              window.location.href = `/library/series?path=${encodeURIComponent(data.newPath)}&autoSync=${data.cvId}`;
          } else throw new Error(data.error);
      } catch (e: any) {
          toast({ title: "Match Failed", description: e.message, variant: "destructive" });
          setIsMatching(false);
      }
  }

  // Pure rely on the existing monitored toggle 
  const handleManualEditSave = async () => {
      setIsSavingEdit(true);
      try {
          const res = await fetch('/api/library/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  currentPath: folderPath, 
                  name: editForm.name,
                  year: editForm.year,
                  publisher: editForm.publisher,
                  cvId: parseInt(editForm.cvId) || 0,
                  monitored: editForm.monitored,
                  isManga: editForm.isManga
              })
          });
          if (!res.ok) throw new Error("Failed to save info.");
          const data = await res.json();
          toast({ title: "Info Updated!" });
          window.location.href = `/library/series?path=${encodeURIComponent(data.newPath)}`;
      } catch (e: any) {
          toast({ title: "Update Failed", description: e.message, variant: "destructive" });
          setIsSavingEdit(false);
      }
  }

  const handleDeleteSeries = async () => {
      setIsDeleting(true);
      try {
          const res = await fetch('/api/library/series', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  seriesIds: seriesInfo.id ? [seriesInfo.id] : [], 
                  deleteFiles: deleteFiles,
                  folderPath: folderPath 
              })
          });
          
          if (!res.ok) throw new Error("Failed to delete series");
          
          toast({ title: "Series Deleted", description: "The series has been removed from your library." });
          
          setIsDeleting(false);
          setDeleteModalOpen(false);
          
          router.push(`/library?refetch=${Date.now()}`);
      } catch (e: any) {
          toast({ title: "Delete Failed", description: e.message, variant: "destructive" });
          setIsDeleting(false);
          setDeleteModalOpen(false);
      }
  }

  const handleDeleteIssue = async () => {
      if (!issueToDelete) return;
      setIsDeletingIssue(true);
      try {
          const res = await fetch('/api/library/issue', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  issueId: issueToDelete.id, 
                  fullPath: issueToDelete.fullPath,
                  deleteFile: deleteIssueFile 
              })
          });
          
          if (!res.ok) throw new Error("Failed to delete issue");
          
          toast({ title: "Issue Deleted", description: "The issue has been successfully removed." });
          
          setDownloadedIssues(prev => prev.filter(i => i.id !== issueToDelete.id));
          
          if (activeIssue?.id === issueToDelete.id) {
              setActiveIssue(null); 
          }

          setIsDeletingIssue(false);
          setDeleteIssueModalOpen(false);
          setIssueToDelete(null);

      } catch (e: any) {
          toast({ title: "Delete Failed", description: e.message, variant: "destructive" });
          setIsDeletingIssue(false);
      }
  }

  const handleSubmitReport = async () => {
      if (!seriesInfo.id) return;
      if (!reportDescription.trim()) {
          toast({ title: "Error", description: "Please enter a description.", variant: "destructive" });
          return;
      }
      setIsSubmittingReport(true);
      try {
          const res = await fetch('/api/reports', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seriesId: seriesInfo.id, description: reportDescription.trim() })
          });
          if (!res.ok) throw new Error("Failed to submit report.");
          toast({ title: "Report Submitted", description: "An admin will review this shortly." });
          setReportModalOpen(false);
          setReportDescription("");
      } catch (e: any) {
          toast({ title: "Error", description: e.message, variant: "destructive" });
      } finally {
          setIsSubmittingReport(false);
      }
  }

  const getImageUrl = (imageObj: any) => {
      if (!imageObj) return null;
      if (typeof imageObj === 'string') return imageObj;
      return imageObj.medium_url || imageObj.screen_url || imageObj.icon_url || null;
  };

  const getReadButtonLabel = (issue: any) => {
    if (!issue) return "Read";
    const isActuallyRead = issue.isRead || (issue.readProgress || 0) >= 100;
    if (issue.readProgress > 0 && !isActuallyRead) return "Resume";
    return "Read";
  };

  if (!folderPath) return <div className="p-10 text-center dark:text-slate-400">No series selected.</div>;

  return (
    <div className="container mx-auto py-10 px-6 max-w-[1400px]">
      <Button variant="ghost" asChild className="mb-6 -ml-4 text-muted-foreground hover:text-foreground">
          <Link href="/library"><ChevronLeft className="w-4 h-4 mr-1" /> Back to Library</Link>
      </Button>

      {loading ? (
        <SeriesDetailSkeleton />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-10">
          
          <div className="space-y-6">
              <div className="space-y-3">
                  
                  {(seriesInfo.publisher || seriesInfo.year) && (
                      <div className="flex items-center justify-between text-[11px] font-black text-muted-foreground uppercase tracking-widest px-1">
                          <span className="truncate pr-2 text-slate-500 dark:text-slate-400">{seriesInfo.publisher || "Unknown Publisher"}</span>
                          <span className="shrink-0 text-slate-400 dark:text-slate-500">{seriesInfo.year}</span>
                      </div>
                  )}

                  <div className="aspect-[2/3] w-full bg-slate-100 dark:bg-slate-900 rounded-2xl border dark:border-slate-800 shadow-xl flex items-center justify-center overflow-hidden relative">
                      <img src={displayCover || seriesInfo.cover} alt="Cover" className="object-cover w-full h-full transition-opacity duration-300" />
                  </div>
                  
                  <div className="text-center md:text-left space-y-1">
                      <h1 className="text-2xl font-black tracking-tight dark:text-slate-100">{seriesInfo.name}</h1>
                      
                      {/* FIXED BADGE ROW: Restored native Status and added Monitored toggle visibility */}
                      <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 pt-1">
                          {seriesInfo.status && (
                              <Badge variant={seriesInfo.status === 'Ongoing' ? 'default' : 'secondary'} className={`uppercase tracking-wider text-[9px] font-black ${seriesInfo.status === 'Ongoing' ? 'bg-green-600 hover:bg-green-700 text-white border-0' : 'dark:bg-slate-800'}`}>
                                  {seriesInfo.status}
                              </Badge>
                          )}
                          {seriesInfo.id && (
                              <Badge variant={seriesInfo.monitored ? 'default' : 'outline'} className={`uppercase tracking-wider text-[9px] font-black ${seriesInfo.monitored ? 'bg-blue-600 hover:bg-blue-700 text-white border-0' : 'text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-800'}`}>
                                  {seriesInfo.monitored ? 'Monitored' : 'Not Monitored'}
                              </Badge>
                          )}
                      </div>
                  </div>
              </div>

              <div className="flex flex-col gap-2">
                  {/* DYNAMIC ACTION BUTTON */}
                  {activeIssue && !activeIssue.fullPath ? (
                      <Button 
                          className="w-full font-black shadow-md bg-blue-600 hover:bg-blue-700 text-white border-0" 
                          size="lg" 
                          disabled={requestingIds.has(activeIssue.id) || requestedIds.has(activeIssue.id)}
                          onClick={() => handleRequestMissing(activeIssue)}
                      >
                          {requestingIds.has(activeIssue.id) ? (
                              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                          ) : requestedIds.has(activeIssue.id) ? (
                              <Check className="w-5 h-5 mr-2" />
                          ) : (
                              <CloudDownload className="w-5 h-5 mr-2" />
                          )}
                          {requestedIds.has(activeIssue.id) ? "Issue Requested" : "Request Selected"}
                      </Button>
                  ) : (
                      <Button 
                        className={`w-full font-black shadow-md ${activeIssue?.readProgress > 0 && !(activeIssue?.isRead || activeIssue?.readProgress >= 100) ? 'bg-blue-600 hover:bg-blue-700 text-white border-0' : ''}`} 
                        size="lg" 
                        disabled={!activeIssue || !activeIssue.fullPath} 
                        onClick={() => router.push(`/reader?path=${encodeURIComponent(activeIssue?.fullPath || '')}&series=${encodeURIComponent(folderPath || '')}`)}>
                          <BookOpen className="w-5 h-5 mr-2" /> 
                          {getReadButtonLabel(activeIssue)} Selected
                      </Button>
                  )}
                  
                  <Button variant={seriesInfo.isFavorite ? "default" : "outline"} className={`w-full font-bold transition-all ${seriesInfo.isFavorite ? 'bg-pink-600 hover:bg-pink-700 text-white border-0' : 'dark:border-slate-800'}`} onClick={toggleFavorite} disabled={!seriesInfo.id}>
                      <Heart className={`w-4 h-4 mr-2 ${seriesInfo.isFavorite ? 'fill-current' : ''}`} /> Favorite
                  </Button>
                  
                  {isAdmin && (
                      <Button variant="outline" className="w-full dark:border-slate-800 font-bold" onClick={() => setEditModalOpen(true)}>
                          <Edit className="w-4 h-4 mr-2" /> Edit Info
                      </Button>
                  )}

                  {isAdmin && (
                      <Button variant={seriesInfo.cvId ? "outline" : "default"} className="w-full dark:border-slate-800 font-bold" onClick={() => { setSearchQuery(seriesInfo.name); setMatchModalOpen(true); }}>
                          <Search className="w-4 h-4 mr-2" /> {seriesInfo.cvId ? "Fix Match" : "Match Series"}
                      </Button>
                  )}
                  
                  {seriesInfo.cvId && (
                      <>
                        <Button variant="outline" className="w-full dark:border-slate-800 font-bold" asChild><Link href={`https://comicvine.gamespot.com/volume/4050-${seriesInfo.cvId}/`} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4 mr-2" /> ComicVine</Link></Button>
                        
                        {isAdmin && (
                            <Button 
                                variant="secondary" 
                                className="w-full transition-all shadow-sm active:scale-95 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 font-bold" 
                                disabled={isRefreshingMetadata} 
                                onClick={handleRefreshMetadata}
                            >
                                {isRefreshingMetadata ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                                Refresh Metadata
                            </Button>
                        )}

                        {isAdmin && (
                            <Button 
                                variant="outline" 
                                className={`w-full transition-all shadow-sm active:scale-95 ${missingIssues.length > 0 ? 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800' : 'opacity-50 grayscale cursor-not-allowed font-bold'}`}
                                disabled={missingIssues.length === 0 || isBulkDownloading}
                                onClick={handleDownloadAllMissing}
                            >
                                {isBulkDownloading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DownloadCloud className="w-4 h-4 mr-2" />}
                                Missing ({missingIssues.length})
                            </Button>
                        )}
                      </>
                  )}

                  <Button variant="outline" className="w-full dark:border-slate-800 font-bold text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 mt-4" onClick={() => setReportModalOpen(true)} disabled={!seriesInfo.id}>
                      <AlertTriangle className="w-4 h-4 mr-2" /> Report Issue
                  </Button>
                  
                  {isAdmin && (
                      <Button variant="destructive" className="w-full font-bold transition-all shadow-sm active:scale-95 hover:bg-red-600 dark:hover:bg-red-700" onClick={() => setDeleteModalOpen(true)}>
                          <Trash2 className="w-4 h-4 mr-2" /> Delete Series
                      </Button>
                  )}
              </div>
          </div>

          <div className="space-y-10 min-w-0">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="flex flex-col h-full bg-white dark:bg-slate-900 p-6 rounded-2xl border dark:border-slate-800 shadow-sm">
                      <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center gap-2">
                          <PenTool className="w-3.5 h-3.5 text-primary"/> Issue Credits
                      </h4>
                      <div className="space-y-4">
                          {writers.length > 0 && (
                              <div>
                                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Writers</span>
                                  <p className="text-sm font-bold dark:text-slate-200 leading-tight">{writers.join(", ")}</p>
                              </div>
                          )}
                          {artists.length > 0 && (
                              <div>
                                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Artists</span>
                                  <p className="text-sm font-bold dark:text-slate-200 leading-tight">{artists.join(", ")}</p>
                              </div>
                          )}
                          {!hasCreators && (
                              <p className="text-sm italic text-muted-foreground opacity-50 py-4 text-center">No credits found for this issue.</p>
                          )}
                      </div>
                  </div>

                  <div className="flex flex-col h-full bg-white dark:bg-slate-900 p-6 rounded-2xl border dark:border-slate-800 shadow-sm">
                      <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center gap-2">
                          <Users className="w-3.5 h-3.5 text-primary"/> Key Appearances
                      </h4>
                      <div className="flex flex-wrap gap-2">
                          {characters.length > 0 ? (
                              characters.slice(0,10).map((char: any, i: number) => (
                                  <Badge key={i} variant="secondary" className="bg-slate-100 dark:bg-slate-800 dark:text-slate-300 font-bold px-3 py-1 border dark:border-slate-700">
                                      <Sparkles className="w-3 h-3 mr-1.5 text-blue-500" /> {char}
                                  </Badge>
                              ))
                          ) : (
                              <p className="text-sm italic text-muted-foreground opacity-50 py-4 text-center w-full">No character metadata found.</p>
                          )}
                      </div>
                  </div>
              </div>

              <div className="space-y-3">
                  <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground px-1">
                    {activeIssue ? `${activeIssue.name} Synopsis` : 'Synopsis'}
                  </h4>
                  <div className="text-sm leading-relaxed bg-white dark:bg-slate-900 p-6 rounded-2xl border dark:border-slate-800 min-h-[120px] dark:text-slate-300 shadow-sm break-words">
                      <div dangerouslySetInnerHTML={{__html: displayDescription}} />
                  </div>
              </div>

              {/* --- DOWNLOADED ISSUES SECTION --- */}
              <div className="space-y-6">
                  <div className="flex items-center justify-between border-b-2 dark:border-slate-800 pb-4">
                      <h4 className="font-black flex items-center gap-2 text-xl dark:text-slate-200 tracking-tight"><Layers className="w-6 h-6 text-blue-500"/> Downloaded Issues ({downloadedIssues.length})</h4>
                      <div className="flex items-center gap-1 border dark:border-slate-800 rounded-md p-1 bg-white dark:bg-slate-950 shadow-sm shrink-0">
                          <Button variant={viewMode === 'grid' ? "secondary" : "ghost"} size="icon" className="h-8 w-8 sm:h-7 sm:w-7" onClick={() => toggleViewMode('grid')}><LayoutGrid className="w-4 h-4" /></Button>
                          <Button variant={viewMode === 'list' ? "secondary" : "ghost"} size="icon" className="h-8 w-8 sm:h-7 sm:w-7" onClick={() => toggleViewMode('list')}><List className="w-4 h-4" /></Button>
                      </div>
                  </div>
                  
                  {viewMode === 'grid' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-4">
                          {downloadedIssues.map((issue) => {
                              const isSelected = activeIssue?.id === issue.id;
                              const isRead = issue.isRead || (issue.readProgress || 0) >= 100;
                              return (
                                  <div 
                                    key={issue.id} 
                                    onClick={() => setActiveIssue(issue)}
                                    className={`flex gap-4 p-4 bg-white dark:bg-slate-900 border-2 rounded-xl shadow-sm relative overflow-hidden transition-all cursor-pointer ${isSelected ? 'border-primary ring-4 ring-primary/10' : 'border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-blue-900'}`}
                                  >
                                    <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden bg-slate-100 dark:bg-slate-800 border dark:border-slate-700 relative">
                                      {issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className={`w-full h-full object-cover ${isRead ? 'opacity-60' : ''}`} alt="" /> : <ImageIcon className="w-8 h-8 m-auto mt-10 text-slate-300" />}
                                      <div className="absolute top-1 right-1 z-10">{isRead ? <Badge className="bg-green-600 border-0 text-[9px] px-1 h-4"><Check className="w-3 h-3"/></Badge> : issue.readProgress > 0 ? <Badge className="bg-blue-600 border-0 text-[9px] px-1 h-4">{Math.round(issue.readProgress)}%</Badge> : null}</div>
                                      {issue.readProgress > 0 && !isRead && <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/50"><div className="h-full bg-blue-500" style={{ width: `${issue.readProgress}%` }} /></div>}
                                    </div>
                                    <div className="flex flex-col justify-between flex-1 py-1 min-w-0">
                                      <div><h5 className={`font-bold text-base line-clamp-2 leading-tight ${isRead ? 'text-muted-foreground' : 'dark:text-slate-200'}`}>{issue.name}</h5>{issue.parsedNum !== null && <span className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</span>}</div>
                                      <div className="flex items-center gap-2 mt-3">
                                        <Button size="sm" variant={isSelected ? "default" : "outline"} className="flex-1 h-9 text-[11px] font-black uppercase tracking-wider" asChild onClick={(e) => e.stopPropagation()}>
                                            <Link href={`/reader?path=${encodeURIComponent(issue.fullPath)}&series=${encodeURIComponent(folderPath || '')}`}>
                                                {getReadButtonLabel(issue)}
                                            </Link>
                                        </Button>
                                        {canDownload && <Button size="sm" variant="secondary" className="h-9 px-3 dark:bg-slate-800" asChild onClick={(e) => e.stopPropagation()}><a href={`/api/library/download?path=${encodeURIComponent(issue.fullPath)}`} download><Download className="w-4 h-4" /></a></Button>}
                                        {isAdmin && (
                                            <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200 dark:hover:border-red-900/50" onClick={(e) => { e.stopPropagation(); setIssueToDelete(issue); setDeleteIssueModalOpen(true); }}>
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                          })}
                      </div>
                  ) : (
                      <div className="border dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-950 shadow-sm mt-4">
                          <div className="overflow-x-auto">
                              <table className="w-full text-sm text-left">
                                  <thead className="text-xs text-muted-foreground uppercase bg-slate-50 dark:bg-slate-900/50 border-b dark:border-slate-800">
                                      <tr>
                                          <th className="w-16 px-4 py-3 text-center">Cover</th>
                                          <th className="px-4 py-3">Issue</th>
                                          <th className="px-4 py-3 text-center">Progress</th>
                                          <th className="px-4 py-3 text-right">Actions</th>
                                      </tr>
                                  </thead>
                                  <tbody className="divide-y dark:divide-slate-800">
                                      {downloadedIssues.map((issue) => {
                                          const isSelected = activeIssue?.id === issue.id;
                                          const isRead = issue.isRead || (issue.readProgress || 0) >= 100;
                                          return (
                                              <tr key={issue.id} onClick={() => setActiveIssue(issue)} className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-50/50 dark:bg-blue-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'}`}>
                                                  <td className="px-4 py-2">
                                                      <div className="w-10 h-14 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden flex items-center justify-center shrink-0 border dark:border-slate-700 relative">
                                                          {issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className={`w-full h-full object-cover ${isRead ? 'opacity-60' : ''}`} alt="" /> : <ImageIcon className="w-4 h-4 text-slate-300 dark:text-slate-600" />}
                                                          {isRead && <div className="absolute inset-0 flex items-center justify-center bg-green-500/20 z-20"><Check className="w-4 h-4 text-green-500 font-bold"/></div>}
                                                      </div>
                                                  </td>
                                                  <td className="px-4 py-3 font-bold">
                                                      <div className={`line-clamp-2 leading-tight ${isRead ? 'text-muted-foreground' : 'text-slate-900 dark:text-slate-100'}`}>{issue.name}</div>
                                                      {issue.parsedNum !== null && <div className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</div>}
                                                  </td>
                                                  <td className="px-4 py-3 text-center">
                                                      {isRead ? <Badge className="bg-green-600 border-0 text-[9px] px-1 h-4"><Check className="w-3 h-3 mr-1"/> Read</Badge> : issue.readProgress > 0 ? <Badge className="bg-blue-600 border-0 text-[9px] px-1 h-4">{Math.round(issue.readProgress)}%</Badge> : <span className="text-muted-foreground text-xs">-</span>}
                                                  </td>
                                                  <td className="px-4 py-3 text-right">
                                                      <div className="flex items-center justify-end gap-2">
                                                          <Button size="sm" variant={isSelected ? "default" : "outline"} className="h-8 text-[11px] font-black uppercase tracking-wider" asChild onClick={(e) => e.stopPropagation()}>
                                                              <Link href={`/reader?path=${encodeURIComponent(issue.fullPath)}&series=${encodeURIComponent(folderPath || '')}`}>
                                                                  {getReadButtonLabel(issue)}
                                                              </Link>
                                                          </Button>
                                                          {canDownload && <Button size="sm" variant="secondary" className="h-8 px-3 dark:bg-slate-800 hidden sm:flex" asChild onClick={(e) => e.stopPropagation()}><a href={`/api/library/download?path=${encodeURIComponent(issue.fullPath)}`} download><Download className="w-4 h-4" /></a></Button>}
                                                          {isAdmin && (
                                                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 hidden sm:flex" onClick={(e) => { e.stopPropagation(); setIssueToDelete(issue); setDeleteIssueModalOpen(true); }}>
                                                                  <Trash2 className="w-4 h-4" />
                                                              </Button>
                                                          )}
                                                      </div>
                                                  </td>
                                              </tr>
                                          )
                                      })}
                                  </tbody>
                              </table>
                          </div>
                      </div>
                  )}
              </div>

              {/* --- MISSING ISSUES SECTION --- */}
              {seriesInfo.cvId && (
                  <div className="space-y-6 pt-4 border-t-2 dark:border-slate-800">
                      <h4 className="font-black flex items-center gap-2 text-xl dark:text-slate-400 opacity-80 tracking-tight"><CloudOff className="w-6 h-6"/> Missing Issues ({missingIssues.length})</h4>
                      
                      {missingIssues.length === 0 ? (
                          <div className="p-10 text-center border border-dashed border-green-200 bg-green-50/20 dark:border-green-900/30 dark:bg-green-900/10 rounded-2xl flex flex-col items-center justify-center transition-all hover:bg-green-50/30">
                              <CheckCircle2 className="w-10 h-10 text-green-500 mb-3" />
                              <p className="text-lg font-black text-green-800 dark:text-green-400 uppercase tracking-tight">Your collection is complete!</p>
                              <p className="text-sm text-green-700/70 dark:text-green-500/70 mt-1">All known issues are currently in your library.</p>
                          </div>
                      ) : viewMode === 'grid' ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-10">
                              {missingIssues.map((issue) => {
                                  const isRequesting = requestingIds.has(issue.id);
                                  const isAlreadyRequested = requestedIds.has(issue.id);
                                  return (
                                      <div key={issue.id} onClick={() => setActiveIssue(issue)} className="flex gap-4 p-4 bg-slate-50 dark:bg-slate-900/50 border dark:border-slate-800/50 rounded-xl shadow-sm opacity-80 hover:opacity-100 transition-all cursor-pointer">
                                        <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden bg-slate-200 dark:bg-slate-800 border dark:border-slate-700 grayscale">{issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-8 h-8 m-auto mt-10 text-slate-400" />}</div>
                                        <div className="flex flex-col justify-between flex-1 py-1 min-w-0">
                                            <div><h5 className="font-bold text-base line-clamp-2 dark:text-slate-300 leading-tight">{issue.name}</h5><span className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</span></div>
                                            <div className="flex items-center gap-2 mt-3">{isAlreadyRequested ? <Button size="sm" variant="secondary" disabled className="flex-1 h-9 bg-green-50 text-green-700 dark:bg-green-900/20 border-green-200 opacity-100 cursor-not-allowed"><Check className="w-4 h-4 mr-2"/> Queued</Button> : <Button size="sm" variant="outline" className="flex-1 h-9 font-black text-[10px] uppercase tracking-wider" onClick={(e) => { e.stopPropagation(); handleRequestMissing(issue); }} disabled={isRequesting}>{isRequesting ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <CloudDownload className="w-4 h-4 mr-2"/>}Request</Button>}</div>
                                        </div>
                                      </div>
                                  );
                              })}
                          </div>
                      ) : (
                          <div className="border dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-950 shadow-sm mt-4 pb-10">
                              <div className="overflow-x-auto">
                                  <table className="w-full text-sm text-left">
                                      <thead className="text-xs text-muted-foreground uppercase bg-slate-50 dark:bg-slate-900/50 border-b dark:border-slate-800">
                                          <tr>
                                              <th className="w-16 px-4 py-3 text-center">Cover</th>
                                              <th className="px-4 py-3">Issue</th>
                                              <th className="px-4 py-3 text-right">Actions</th>
                                          </tr>
                                      </thead>
                                      <tbody className="divide-y dark:divide-slate-800">
                                          {missingIssues.map((issue) => {
                                              const isRequesting = requestingIds.has(issue.id);
                                              const isAlreadyRequested = requestedIds.has(issue.id);
                                              return (
                                                  <tr key={issue.id} onClick={() => setActiveIssue(issue)} className={`cursor-pointer transition-colors ${requestingIds.has(issue.id) ? 'opacity-50' : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'}`}>
                                                      <td className="px-4 py-2">
                                                          <div className="w-10 h-14 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden flex items-center justify-center shrink-0 border dark:border-slate-700 grayscale relative">
                                                              {issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-4 h-4 text-slate-400" />}
                                                          </div>
                                                      </td>
                                                      <td className="px-4 py-3 font-bold">
                                                          <div className="line-clamp-2 leading-tight dark:text-slate-300">{issue.name}</div>
                                                          {issue.parsedNum !== null && <div className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</div>}
                                                      </td>
                                                      <td className="px-4 py-3 text-right">
                                                          {isAlreadyRequested ? (
                                                              <Button size="sm" variant="secondary" disabled className="h-8 bg-green-50 text-green-700 dark:bg-green-900/20 border-green-200 opacity-100 cursor-not-allowed">
                                                                  <Check className="w-3.5 h-3.5 mr-1"/> Requested
                                                              </Button>
                                                          ) : (
                                                              <Button size="sm" variant="outline" className="h-8 font-bold text-[10px] uppercase tracking-wider" onClick={(e) => { e.stopPropagation(); handleRequestMissing(issue); }} disabled={isRequesting}>
                                                                  {isRequesting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1"/> : <CloudDownload className="w-3.5 h-3.5 mr-1"/>} Request
                                                              </Button>
                                                          )}
                                                      </td>
                                                  </tr>
                                              )
                                          })}
                                      </tbody>
                                  </table>
                              </div>
                          </div>
                      )}
                  </div>
              )}
          </div>
        </div>
      )}

      {/* --- DIALOGS --- */}
      <Dialog open={matchModalOpen} onOpenChange={setMatchModalOpen}>
          <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col dark:bg-slate-950 dark:border-slate-800">
              <DialogHeader><DialogTitle>Match Series</DialogTitle></DialogHeader>
              <form onSubmit={(e) => performSearch(e, false)} className="flex gap-2">
                  <Input placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                  <Button type="submit" disabled={isSearching}><Search className="w-4 h-4" /></Button>
              </form>
              
              <div className="flex-1 overflow-y-auto mt-4 pb-4 px-1">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {searchResults.map((item) => (
                          <div key={item.id} className="cursor-pointer space-y-2 group flex flex-col" onClick={() => handleMatch(item)}>
                              <div className="aspect-[2/3] bg-slate-100 dark:bg-slate-900 rounded-lg overflow-hidden border dark:border-slate-800 relative shadow-sm">
                                  {item.image && <img src={getImageUrl(item.image) || ""} className="object-cover w-full h-full" alt="" />}
                                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                      <Button size="sm" className="font-bold shadow-lg" disabled={isMatching}>
                                          {isMatching ? <Loader2 className="animate-spin w-4 h-4" /> : "Select"}
                                      </Button>
                                  </div>
                              </div>
                              <div className="flex flex-col items-center text-center px-1">
                                  <h4 className="text-xs font-black line-clamp-1 dark:text-slate-200" title={item.name}>{item.name}</h4>
                                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 line-clamp-1" title={item.publisher}>{item.publisher || "Unknown"}</span>
                                  <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mt-0.5">
                                      {item.year || "????"} • {item.count || 0} Issues
                                  </span>
                              </div>
                          </div>
                      ))}
                  </div>

                  {hasMoreSearch && (
                      <div className="mt-8 mb-4 flex justify-center">
                          <Button 
                              variant="secondary" 
                              onClick={() => performSearch(undefined, true)} 
                              disabled={isSearchingMore}
                              className="font-bold shadow-sm"
                          >
                              {isSearchingMore ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                              Load More Results
                          </Button>
                      </div>
                  )}

              </div>
          </DialogContent>
      </Dialog>

      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
          <DialogContent className="sm:max-w-[450px] dark:bg-slate-950 dark:border-slate-800">
              <DialogHeader><DialogTitle>Edit Series Info</DialogTitle></DialogHeader>
              <div className="grid gap-4 py-4">
                  <div className="grid gap-2"><Label>Source Folder Path</Label><div className="flex gap-2"><Input readOnly value={seriesInfo.path || folderPath!} className="bg-muted text-xs truncate" /><Button variant="secondary" size="icon" onClick={copyToClipboard}>{copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}</Button></div></div>
                  <div className="grid gap-2"><Label>ComicVine ID</Label><Input type="number" value={editForm.cvId} onChange={(e) => setEditForm({...editForm, cvId: e.target.value})} /></div>
                  <div className="grid gap-2"><Label>Publisher</Label><Input value={editForm.publisher} onChange={(e) => setEditForm({...editForm, publisher: e.target.value})} /></div>
                  <div className="grid gap-2"><Label>Series Name</Label><Input value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})} /></div>
                  <div className="grid gap-2"><Label>Year</Label><Input value={editForm.year} onChange={(e) => setEditForm({...editForm, year: e.target.value})} /></div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                      <div className="flex items-center gap-2">
                          <Switch checked={editForm.monitored} onCheckedChange={v => setEditForm({...editForm, monitored: v})} />
                          <Label>Monitor for New Issues</Label>
                      </div>
                      <div className="flex items-center gap-2">
                          <Switch checked={editForm.isManga} onCheckedChange={v => setEditForm({...editForm, isManga: v})} />
                          <Label>Flag as Manga (Right-to-Left)</Label>
                      </div>
                  </div>
              </div>
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEditModalOpen(false)}>Cancel</Button><Button className="bg-blue-600 font-bold hover:bg-blue-700 text-white" onClick={handleManualEditSave} disabled={isSavingEdit}>{isSavingEdit ? <Loader2 className="animate-spin mr-2" /> : "Save Changes"}</Button></div>
          </DialogContent>
      </Dialog>

      <Dialog open={deleteModalOpen} onOpenChange={setDeleteModalOpen}>
          <DialogContent className="sm:max-w-[425px] dark:bg-slate-950 dark:border-slate-800">
              <DialogHeader>
                  <DialogTitle className="text-red-600 flex items-center gap-2"><Trash2 className="w-5 h-5"/> Delete Series</DialogTitle>
                  <DialogDescription className="pt-2">
                      Are you sure you want to remove <strong>{seriesInfo.name}</strong> from your library?
                  </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                  <div className="flex items-center space-x-2 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-900/50">
                      <Switch id="delete-files" checked={deleteFiles} onCheckedChange={setDeleteFiles} />
                      <Label htmlFor="delete-files" className="text-sm font-semibold text-red-800 dark:text-red-400 cursor-pointer">
                          Also delete all physical files from disk
                      </Label>
                  </div>
              </div>
              <DialogFooter className="flex gap-2 sm:gap-0">
                  <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={isDeleting}>Cancel</Button>
                  <Button variant="destructive" onClick={handleDeleteSeries} disabled={isDeleting}>
                      {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />} Delete
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={deleteIssueModalOpen} onOpenChange={setDeleteIssueModalOpen}>
          <DialogContent className="sm:max-w-[425px] dark:bg-slate-950 dark:border-slate-800">
              <DialogHeader>
                  <DialogTitle className="text-red-600 flex items-center gap-2"><Trash2 className="w-5 h-5"/> Delete Issue</DialogTitle>
                  <DialogDescription className="pt-2">
                      Are you sure you want to remove <strong>{issueToDelete?.name}</strong>?
                  </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                  <div className="flex items-center space-x-2 bg-red-50 dark:bg-red-950/30 p-3 rounded-lg border border-red-200 dark:border-red-900/50">
                      <Switch id="delete-issue-file" checked={deleteIssueFile} onCheckedChange={setDeleteIssueFile} />
                      <Label htmlFor="delete-issue-file" className="text-sm font-semibold text-red-800 dark:text-red-400 cursor-pointer">
                          Also delete the physical file from disk
                      </Label>
                  </div>
              </div>
              <DialogFooter className="flex gap-2 sm:gap-0">
                  <Button variant="outline" onClick={() => setDeleteIssueModalOpen(false)} disabled={isDeletingIssue}>Cancel</Button>
                  <Button variant="destructive" onClick={handleDeleteIssue} disabled={isDeletingIssue}>
                      {isDeletingIssue ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />} Delete
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={reportModalOpen} onOpenChange={setReportModalOpen}>
          <DialogContent className="sm:max-w-[425px] dark:bg-slate-950 dark:border-slate-800">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-red-600">
                      <AlertTriangle className="w-5 h-5" /> Report an Issue
                  </DialogTitle>
                  <DialogDescription>
                      Let the admins know if something is wrong with this series (e.g. broken pages, wrong metadata, incorrect files).
                  </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                  <Textarea 
                      placeholder="Describe the issue here..." 
                      value={reportDescription} 
                      onChange={(e) => setReportDescription(e.target.value)}
                      className="h-32 dark:bg-slate-900 dark:border-slate-800"
                  />
              </div>
              <DialogFooter>
                  <Button variant="outline" onClick={() => setReportModalOpen(false)} disabled={isSubmittingReport}>Cancel</Button>
                  <Button onClick={handleSubmitReport} disabled={isSubmittingReport} className="bg-red-600 hover:bg-red-700 text-white font-bold">
                      {isSubmittingReport ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : "Submit Report"}
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>
    </div>
  )
}

export default function SeriesPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center">Loading series data...</div>}>
      <SeriesContent />
    </Suspense>
  )
}