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
  LayoutGrid, List, CheckSquare, Square, EyeOff, Tags, BookMarked, Star
} from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Logger } from "@/lib/logger"
import { getErrorMessage } from "@/lib/utils/error"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

function SeriesDetailSkeleton() {
  return (
    <div className="animate-pulse space-y-8">
      <div className="space-y-3">
        <div className="h-9 w-64 bg-muted rounded" />
        <div className="flex gap-3">
          <div className="h-5 w-20 bg-muted rounded-full" />
          <div className="h-5 w-32 bg-muted rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-10">
        <div className="aspect-[2/3] w-full bg-muted rounded-2xl" />
        <div className="space-y-6">
          <div className="h-40 w-full bg-muted rounded-2xl" />
          <div className="h-60 w-full bg-muted rounded-2xl" />
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
  
  const [seriesInfo, setSeriesInfo] = useState<{name: string, cover: string | null, cvId: number | null, metadataId: string | null, metadataSource: string, path: string | null, id: string | null, isFavorite: boolean, publisher: string | null, year: string | null, description: string | null, status: string | null, monitored: boolean}>({ 
    name: "", cover: null, cvId: null, metadataId: null, metadataSource: 'COMICVINE', path: null, id: null, isFavorite: false, publisher: null, year: null, description: null, status: null, monitored: false
  });

  const [searchProvider, setSearchProvider] = useState("COMICVINE");
  
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

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState<Set<string>>(new Set());
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  // --- BULK SPREADSHEET EDITOR STATES ---
  const [bulkEditModalOpen, setBulkEditModalOpen] = useState(false);
  const [bulkEditData, setBulkEditData] = useState<any[]>([]);

  // --- REVIEWS STATE ---
  const [reviews, setReviews] = useState<any[]>([]);
  const [communityRating, setCommunityRating] = useState<{avg: number, total: number}>({ avg: 0, total: 0 });
  const [userReview, setUserReview] = useState({ rating: 0, text: "" });
  const [submittingReview, setSubmittingReview] = useState(false);

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
                metadataId: data.metadataId,
                metadataSource: data.metadataSource || 'COMICVINE',
                path: data.path || folderPath,
                id: data.id || null, 
                isFavorite: data.isFavorite || false,
                publisher: data.publisher || null, 
                year: data.year ? data.year.toString() : null,
                description: data.description || null,
                status: data.status || null,
                monitored: data.monitored || false
            });
            
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
        .catch(e => { Logger.log(`Scan Failed: ${e.message}`, 'error'); })
        .finally(() => setLoading(false));
  }, [folderPath]);

  // --- FETCH REVIEWS ---
  useEffect(() => {
      if (!seriesInfo.id) return;
      fetch(`/api/reviews?seriesId=${seriesInfo.id}`)
          .then(res => res.json())
          .then(data => {
              if (data.reviews) {
                  setReviews(data.reviews);
                  setCommunityRating({ avg: data.avgRating, total: data.total });
                  const myReview = data.reviews.find((r: any) => r.userId === (session?.user as any)?.id);
                  if (myReview) setUserReview({ rating: myReview.rating, text: myReview.text || "" });
              }
          });
  }, [seriesInfo.id, session]);

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
                    genres: data.genres?.length > 0 ? data.genres : prev.genres,
                    storyArcs: data.storyArcs?.length > 0 ? data.storyArcs : prev.storyArcs, 
                    description: data.description || prev.description
                }));
            }
        })
        .catch(() => {});
        
    return () => { isMounted = false; };
  }, [activeIssue?.id]);

  const runAutoDeepScan = async (cvId: string, currentPath: string, source: string = 'COMICVINE') => {
      setIsRefreshingMetadata(true);
      setTimeout(() => { toast({ title: "Downloading Deep Metadata", description: "Fetching writers, artists, and synopsis in the background..." }); }, 100);

      try {
          const res = await fetch('/api/library/refresh-metadata', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ metadataId: cvId, metadataSource: source, folderPath: currentPath })
          });
          if (res.ok) {
              toast({ title: "Metadata Complete!", description: "Refreshing page with new data..." });
              setTimeout(() => { window.location.reload(); }, 1500);
          }
      } catch (e) {
          Logger.log(getErrorMessage(e), 'error');
      } finally {
          setIsRefreshingMetadata(false);
      }
  };

  useEffect(() => {
    const autoSync = searchParams.get('autoSync');
    const provider = searchParams.get('provider') || 'COMICVINE';
    if (autoSync && folderPath && !loading) {
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('autoSync');
        newUrl.searchParams.delete('provider');
        window.history.replaceState({}, '', newUrl.toString());
        runAutoDeepScan(autoSync, folderPath, provider);
    }
  }, [searchParams, folderPath, loading]);

  const writers = activeIssue?.writers || [];
  const artists = activeIssue?.artists || [];
  const characters = activeIssue?.characters || [];
  const genres = activeIssue?.genres || []; 
  const storyArcs = activeIssue?.storyArcs || [];
  const displayDescription = activeIssue?.description || seriesInfo.description || "No synopsis available.";
  const displayCover = activeIssue?.coverUrl || seriesInfo.cover;
  const hasCreators = writers.length > 0 || artists.length > 0;

  const handleRefreshMetadata = async () => {
    if (!seriesInfo.metadataId && !seriesInfo.cvId) return;
    setIsRefreshingMetadata(true);
    toast({ title: "Syncing Metadata", description: "Downloading issues, credits, and synopsis. This may take a few seconds..." });
    
    try {
        const targetId = seriesInfo.metadataId || seriesInfo.cvId?.toString();
        const res = await fetch('/api/library/refresh-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metadataId: targetId, metadataSource: seriesInfo.metadataSource || 'COMICVINE', folderPath: folderPath })
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
      } catch (error: unknown) {
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

      if (!isLoadMore) setIsSearching(true);
      else setIsSearchingMore(true);

      try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&page=${nextPage}&provider=${searchProvider}`);
          const data = await res.json();
          
          if (isLoadMore) setSearchResults(prev => [...prev, ...(data.results || [])]);
          else setSearchResults(data.results || []);
          
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
          const safeYear = item.year ? item.year.toString() : new Date().getFullYear().toString();
          let safePublisher = item.publisher || "Unknown";
          
          const res = await fetch('/api/library/match-series', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  oldFolderPath: folderPath,
                  metadataId: item.id || item.sourceId,
                  metadataSource: searchProvider,
                  name: item.name || "Unknown",
                  year: safeYear,
                  publisher: safePublisher
              })
          });
          const data = await res.json();
          if (data.success) {
              toast({ title: "Series Matched!" });
              window.location.href = `/library/series?path=${encodeURIComponent(data.newPath)}&autoSync=${data.cvId || data.metadataId}&provider=${searchProvider}`;
          } else throw new Error(data.error);
      } catch (e: any) {
          toast({ title: "Match Failed", description: e.message, variant: "destructive" });
          setIsMatching(false);
      }
  }

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
          router.push('/library?refetch=true');
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

  const handleToggleRead = async (issue: any, markAsRead: boolean) => {
    try {
        await fetch('/api/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filePath: issue.fullPath,
                currentPage: markAsRead ? 100 : 0,
                totalPages: 100
            })
        });

        setDownloadedIssues(prev => prev.map(i => {
            if (i.id === issue.id) {
                return { ...i, isRead: markAsRead, readProgress: markAsRead ? 100 : 0 };
            }
            return i;
        }));
        
        if (activeIssue?.id === issue.id) {
            setActiveIssue((prev: any) => ({ ...prev, isRead: markAsRead, readProgress: markAsRead ? 100 : 0 }));
        }

        toast({ title: "Success", description: `Issue marked as ${markAsRead ? 'read' : 'unread'}.` });
    } catch (e) {
        toast({ title: "Error", description: "Failed to update status.", variant: "destructive" });
    }
  }

  const handleBulkProgress = async (markAsRead: boolean) => {
    setIsBulkProcessing(true);
    try {
        const issuesToUpdate = downloadedIssues.filter(i => selectedIssues.has(i.id));
        const promises = issuesToUpdate.map(issue =>
            fetch('/api/progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filePath: issue.fullPath,
                    currentPage: markAsRead ? 100 : 0,
                    totalPages: 100
                })
            })
        );

        await Promise.all(promises);

        setDownloadedIssues(prev => prev.map(i => {
            if (selectedIssues.has(i.id)) {
                return { ...i, isRead: markAsRead, readProgress: markAsRead ? 100 : 0 };
            }
            return i;
        }));

        toast({ title: "Bulk Update Success", description: `Marked ${selectedIssues.size} issues as ${markAsRead ? 'read' : 'unread'}.` });
        setSelectedIssues(new Set());
        setIsSelectionMode(false);
    } catch (e) {
        toast({ title: "Error", description: "Failed to bulk update.", variant: "destructive" });
    } finally {
        setIsBulkProcessing(false);
    }
  }

  const handleSpreadsheetSave = async () => {
      setIsBulkProcessing(true);
      try {
          const res = await fetch('/api/library/issue/bulk', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: bulkEditData })
          });
          if (res.ok) {
              toast({ title: "Issues Updated Successfully" });
              setBulkEditModalOpen(false);
              setSelectedIssues(new Set());
              setIsSelectionMode(false);
              window.location.reload(); // Refresh to catch new ordering
          } else {
              toast({ title: "Save Failed", variant: "destructive" });
          }
      } catch(e) {
          toast({ title: "Error", variant: "destructive" });
      } finally {
          setIsBulkProcessing(false);
      }
  }

  // --- SUBMIT REVIEW ---
  const submitReview = async () => {
    setSubmittingReview(true);
    try {
        await fetch('/api/reviews', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seriesId: seriesInfo.id, rating: userReview.rating, text: userReview.text })
        });
        toast({ title: "Review Saved!" });
        // Re-fetch reviews to update average
        const res = await fetch(`/api/reviews?seriesId=${seriesInfo.id}`);
        const data = await res.json();
        setReviews(data.reviews);
        setCommunityRating({ avg: data.avgRating, total: data.total });
    } catch (e) {
        toast({ title: "Failed to save review", variant: "destructive" });
    } finally {
        setSubmittingReview(false);
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

  if (!folderPath) return <div className="p-10 text-center text-muted-foreground">No series selected.</div>;

  return (
    <div className="container mx-auto py-10 px-6 max-w-[1400px] transition-colors duration-300">
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
                      <div className="flex items-center justify-between text-[11px] font-black text-muted-foreground uppercase tracking-widest px-1 mb-1">
                          <span className="truncate pr-2 text-muted-foreground">{seriesInfo.publisher || "Unknown Publisher"}</span>
                          <span className="shrink-0 text-muted-foreground">{seriesInfo.year}</span>
                      </div>
                  )}

                  <div className="aspect-[2/3] w-full bg-muted rounded-2xl border border-border shadow-xl flex items-center justify-center overflow-hidden relative">
                      <img src={displayCover || seriesInfo.cover} alt="Cover" className="object-cover w-full h-full transition-opacity duration-300" />
                  </div>
                  
                  <div className="text-center md:text-left space-y-1">
                      <h1 className="text-2xl font-black tracking-tight text-foreground">{seriesInfo.name}</h1>
                  </div>
              </div>

              <div className="flex flex-col gap-2">
                  <div className="flex gap-2 pb-1">
                      {seriesInfo.status && (
                          <Badge variant={seriesInfo.status === 'Ongoing' ? 'default' : 'secondary'} className={`w-full flex-1 justify-center uppercase tracking-wider text-[10px] h-7 font-black ${seriesInfo.status === 'Ongoing' ? 'bg-green-600 hover:bg-green-700 text-white border-0' : 'bg-muted text-foreground border-border'}`}>
                              {seriesInfo.status}
                          </Badge>
                      )}
                      {seriesInfo.id && (
                          <Badge variant={seriesInfo.monitored ? 'default' : 'outline'} className={`w-full flex-1 justify-center uppercase tracking-wider text-[10px] h-7 font-black ${seriesInfo.monitored ? 'bg-primary hover:bg-primary/90 text-primary-foreground border-0' : 'text-muted-foreground border-border'}`}>
                              {seriesInfo.monitored ? 'Monitored' : 'Not Monitored'}
                          </Badge>
                      )}
                  </div>
                  
                  {/* DYNAMIC ACTION BUTTON */}
                  {activeIssue && !activeIssue.fullPath ? (
                      <Button 
                          className="w-full font-black shadow-md bg-primary hover:bg-primary/90 text-primary-foreground border-0" 
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
                        className={`w-full font-black shadow-md ${activeIssue?.readProgress > 0 && !(activeIssue?.isRead || activeIssue?.readProgress >= 100) ? 'bg-primary hover:bg-primary/90 text-primary-foreground border-0' : ''}`} 
                        size="lg" 
                        disabled={!activeIssue || !activeIssue.fullPath} 
                        onClick={() => router.push(`/reader?path=${encodeURIComponent(activeIssue?.fullPath || '')}&series=${encodeURIComponent(folderPath || '')}`)}>
                          <BookOpen className="w-5 h-5 mr-2" /> 
                          {getReadButtonLabel(activeIssue)} Selected
                      </Button>
                  )}
                  
                  <Button variant={seriesInfo.isFavorite ? "default" : "outline"} className={`w-full font-bold transition-all ${seriesInfo.isFavorite ? 'bg-primary hover:bg-primary/90 text-primary-foreground border-0' : 'border-border hover:bg-muted'}`} onClick={toggleFavorite} disabled={!seriesInfo.id}>
                      <Heart className={`w-4 h-4 mr-2 ${seriesInfo.isFavorite ? 'fill-current' : ''}`} /> Favorite
                  </Button>
                  
                  {isAdmin && (
                      <Button variant="outline" className="w-full border-border hover:bg-muted text-foreground font-bold" onClick={() => setEditModalOpen(true)}>
                          <Edit className="w-4 h-4 mr-2" /> Edit Info
                      </Button>
                  )}

                  {isAdmin && (
                      <Button variant={seriesInfo.cvId ? "outline" : "default"} className={`w-full font-bold ${seriesInfo.cvId ? 'border-border hover:bg-muted text-foreground' : ''}`} onClick={() => { setSearchQuery(seriesInfo.name); setMatchModalOpen(true); }}>
                          <Search className="w-4 h-4 mr-2" /> {seriesInfo.cvId ? "Fix Match" : "Match Series"}
                      </Button>
                  )}
                  
                  {seriesInfo.cvId && (
                      <>
                        <Button variant="outline" className="w-full border-border hover:bg-muted text-foreground font-bold" asChild><Link href={`https://comicvine.gamespot.com/volume/4050-${seriesInfo.cvId}/`} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4 mr-2" /> ComicVine</Link></Button>
                        
                        {isAdmin && (
                            <Button 
                                variant="secondary" 
                                className="w-full transition-all shadow-sm active:scale-95 border-border hover:bg-muted text-foreground font-bold" 
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
                                className={`w-full transition-all shadow-sm active:scale-95 ${missingIssues.length > 0 ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20' : 'opacity-50 grayscale cursor-not-allowed font-bold'}`}
                                disabled={missingIssues.length === 0 || isBulkDownloading}
                                onClick={handleDownloadAllMissing}
                            >
                                {isBulkDownloading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DownloadCloud className="w-4 h-4 mr-2" />}
                                Missing ({missingIssues.length})
                            </Button>
                        )}
                      </>
                  )}

                  <Button variant="outline" className="w-full border-border font-bold text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 mt-4" onClick={() => setReportModalOpen(true)} disabled={!seriesInfo.id}>
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
                  <div className="flex flex-col h-full bg-background p-6 rounded-2xl border border-border shadow-sm">
                      <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center gap-2">
                          <PenTool className="w-3.5 h-3.5 text-primary"/> Issue Credits
                      </h4>
                      {hasCreators ? (
                          <div className="grid grid-cols-2 gap-4">
                              {writers.length > 0 && (
                                  <div>
                                      <p className="text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Writer</p>
                                      <p className="text-sm font-medium text-foreground">{writers.join(", ")}</p>
                                  </div>
                              )}
                              {artists.length > 0 && (
                                  <div>
                                      <p className="text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Artist</p>
                                      <p className="text-sm font-medium text-foreground">{artists.join(", ")}</p>
                                  </div>
                              )}
                          </div>
                      ) : (
                          <p className="text-sm italic text-muted-foreground opacity-50 py-4 text-center">No credits found for this issue.</p>
                      )}
                  </div>

                  <div className="flex flex-col h-full bg-background p-6 rounded-2xl border border-border shadow-sm">
                      <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-4 flex items-center gap-2">
                          <Users className="w-3.5 h-3.5 text-primary"/> Key Appearances
                      </h4>
                      <div className="flex flex-wrap gap-2">
                          {characters.length > 0 ? (
                              characters.slice(0,10).map((char: any, i: number) => (
                                  <Badge key={i} variant="secondary" className="bg-muted text-foreground font-bold px-3 py-1 border border-border hover:bg-muted/80">
                                      <Sparkles className="w-3 h-3 mr-1.5 text-primary" /> {char}
                                  </Badge>
                              ))
                          ) : (
                              <p className="text-sm italic text-muted-foreground opacity-50 py-4 text-center w-full">No character metadata found.</p>
                          )}
                      </div>

                      {genres.length > 0 && (
                          <div className="space-y-2 mt-4 pt-4 border-t border-border">
                              <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Tags className="w-4 h-4 text-primary"/> Genres & Concepts</h4>
                              <div className="flex flex-wrap gap-1.5">
                                  {genres.map((genre: string) => (
                                      <Badge key={genre} variant="outline" className="font-medium text-[10px] bg-background text-muted-foreground border-border hover:text-foreground">{genre}</Badge>
                                  ))}
                              </div>
                          </div>
                      )}

                      {storyArcs.length > 0 && (
                          <div className="space-y-2 mt-4 pt-4 border-t border-border">
                              <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><BookMarked className="w-4 h-4 text-primary"/> Story Arcs</h4>
                              <div className="flex flex-wrap gap-1.5">
                                  {storyArcs.map((arc: string) => (
                                      <Badge key={arc} className="font-medium text-[10px] bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">{arc}</Badge>
                                  ))}
                              </div>
                          </div>
                      )}
                  </div>
              </div>

              <div className="space-y-3">
                  <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground px-1">
                    {activeIssue ? `${activeIssue.name} Synopsis` : 'Synopsis'}
                  </h4>
                  <div className="text-sm leading-relaxed bg-muted/30 p-6 rounded-2xl border border-border min-h-[120px] text-foreground shadow-sm break-words">
                      <div dangerouslySetInnerHTML={{__html: displayDescription}} />
                  </div>
              </div>

              {/* --- COMMUNITY REVIEWS SECTION --- */}
              <div className="space-y-6 mt-8 pt-8 border-t border-border">
                  <div className="flex items-center justify-between">
                      <h4 className="font-black text-xl text-foreground tracking-tight">Community Reviews</h4>
                      {communityRating.total > 0 && (
                          <div className="flex items-center gap-2">
                              <Star className="w-5 h-5 fill-yellow-500 text-yellow-500" />
                              <span className="font-bold text-lg">{communityRating.avg} / 5</span>
                              <span className="text-sm text-muted-foreground">({communityRating.total} ratings)</span>
                          </div>
                      )}
                  </div>

                  {/* Review Form */}
                  <div className="bg-muted/30 p-4 rounded-xl border border-border space-y-4">
                      <h5 className="text-sm font-bold">Leave a Review</h5>
                      <div className="flex gap-1">
                          {[1, 2, 3, 4, 5].map(star => (
                              <Star 
                                  key={star} 
                                  className={`w-6 h-6 cursor-pointer transition-colors ${userReview.rating >= star ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`}
                                  onClick={() => setUserReview({ ...userReview, rating: star })}
                              />
                          ))}
                      </div>
                      <Textarea 
                          placeholder="Write your thoughts here (optional)..." 
                          value={userReview.text}
                          onChange={(e) => setUserReview({ ...userReview, text: e.target.value })}
                          className="bg-background"
                      />
                      <Button onClick={submitReview} disabled={submittingReview || userReview.rating === 0}>
                          {submittingReview ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null} Submit Review
                      </Button>
                  </div>

                  {/* Review List */}
                  <div className="space-y-4">
                      {reviews.map(r => (
                          <div key={r.id} className="p-4 border border-border rounded-lg bg-background shadow-sm">
                              <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                      <div className="w-6 h-6 bg-primary/20 rounded-full flex items-center justify-center font-bold text-[10px] text-primary">
                                          {r.user.username.charAt(0).toUpperCase()}
                                      </div>
                                      <span className="font-bold text-sm">{r.user.username}</span>
                                  </div>
                                  <div className="flex gap-0.5">
                                      {[...Array(r.rating)].map((_, i) => <Star key={i} className="w-3 h-3 fill-yellow-500 text-yellow-500" />)}
                                  </div>
                              </div>
                              {r.text && <p className="text-sm text-muted-foreground">{r.text}</p>}
                          </div>
                      ))}
                  </div>
              </div>

              {/* --- DOWNLOADED ISSUES SECTION --- */}
              <div className="space-y-6">
                  <div className="flex items-center justify-between border-b-2 border-border pb-4">
                      <h4 className="font-black flex items-center gap-2 text-xl text-foreground tracking-tight"><Layers className="w-6 h-6 text-primary"/> Downloaded Issues ({downloadedIssues.length})</h4>
                      <div className="flex items-center gap-1 border border-border rounded-md p-1 bg-background shadow-sm shrink-0">
                          <Button variant={isSelectionMode ? "secondary" : "ghost"} size="sm" className="h-8 px-2 text-xs font-bold" onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedIssues(new Set()); }}>
                              {isSelectionMode ? <Square className="w-4 h-4 sm:mr-1" /> : <CheckSquare className="w-4 h-4 sm:mr-1" />}
                              <span className="hidden sm:inline">{isSelectionMode ? "Cancel" : "Select"}</span>
                          </Button>
                          <div className="w-px h-4 bg-border mx-1" />
                          <Button variant={viewMode === 'grid' ? "secondary" : "ghost"} size="icon" className="h-8 w-8 sm:h-7 sm:w-7" onClick={() => toggleViewMode('grid')}><LayoutGrid className="w-4 h-4" /></Button>
                          <Button variant={viewMode === 'list' ? "secondary" : "ghost"} size="icon" className="h-8 w-8 sm:h-7 sm:w-7" onClick={() => toggleViewMode('list')}><List className="w-4 h-4" /></Button>
                      </div>
                  </div>
                  
                  {viewMode === 'grid' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-4">
                          {downloadedIssues.map((issue) => {
                              const isSelected = activeIssue?.id === issue.id || selectedIssues.has(issue.id);
                              const isRead = issue.isRead || (issue.readProgress || 0) >= 100;
                              return (
                                  <div 
                                    key={issue.id} 
                                    onClick={() => {
                                        if (isSelectionMode) {
                                            const next = new Set(selectedIssues);
                                            if (next.has(issue.id)) next.delete(issue.id);
                                            else next.add(issue.id);
                                            setSelectedIssues(next);
                                        } else {
                                            setActiveIssue(issue);
                                        }
                                    }}
                                    className={`flex gap-4 p-4 bg-background border-2 rounded-xl shadow-sm relative overflow-hidden transition-all cursor-pointer ${isSelected ? (isSelectionMode ? 'border-primary ring-2 ring-primary/20 scale-[0.98]' : 'border-primary ring-4 ring-primary/10') : 'border-border hover:border-primary/50'}`}
                                  >
                                    {isSelectionMode && (
                                       <div className="absolute top-2 left-2 z-40 bg-black/50 backdrop-blur-sm rounded p-1 pointer-events-none">
                                           {selectedIssues.has(issue.id) ? <CheckSquare className="w-5 h-5 text-primary" /> : <Square className="w-5 h-5 text-white/80" />}
                                       </div>
                                    )}
                                    <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden bg-muted border border-border relative">
                                      {issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className={`w-full h-full object-cover ${isRead ? 'opacity-60' : ''}`} alt="" /> : <ImageIcon className="w-8 h-8 m-auto mt-10 text-muted-foreground/50" />}
                                      <div className="absolute top-1 right-1 z-10">{isRead ? <Badge className="bg-green-600 border-0 text-[9px] px-1 h-4"><Check className="w-3 h-3"/></Badge> : issue.readProgress > 0 ? <Badge className="bg-primary border-0 text-primary-foreground text-[9px] px-1 h-4">{Math.round(issue.readProgress)}%</Badge> : null}</div>
                                      {issue.readProgress > 0 && !isRead && <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/50"><div className="h-full bg-primary" style={{ width: `${issue.readProgress}%` }} /></div>}
                                    </div>
                                    <div className="flex flex-col justify-between flex-1 py-1 min-w-0">
                                      <div><h5 className={`font-bold text-base line-clamp-2 leading-tight ${isRead ? 'text-muted-foreground' : 'text-foreground'}`}>{issue.name}</h5>{issue.parsedNum !== null && <span className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</span>}</div>
                                      <div className="flex items-center gap-2 mt-3">
                                        <Button size="sm" variant={isSelected && !isSelectionMode ? "default" : "outline"} className="flex-1 h-9 text-[11px] font-black uppercase tracking-wider" asChild onClick={(e) => { if (isSelectionMode) { e.preventDefault(); } else { e.stopPropagation(); } }}>
                                            <Link href={`/reader?path=${encodeURIComponent(issue.fullPath)}&series=${encodeURIComponent(folderPath || '')}`}>
                                                {getReadButtonLabel(issue)}
                                            </Link>
                                        </Button>
                                        
                                        {!isSelectionMode && (
                                            <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground hover:bg-muted shrink-0" onClick={(e) => { e.stopPropagation(); handleToggleRead(issue, !isRead); }} title={isRead ? "Mark Unread" : "Mark Read"}>
                                                {isRead ? <EyeOff className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                                            </Button>
                                        )}

                                        {canDownload && !isSelectionMode && <Button size="sm" variant="secondary" className="h-9 px-3 bg-muted hover:bg-muted/80 text-foreground border-border" asChild onClick={(e) => e.stopPropagation()}><a href={`/api/library/download?path=${encodeURIComponent(issue.fullPath)}`} download><Download className="w-4 h-4" /></a></Button>}
                                        {isAdmin && !isSelectionMode && (
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
                      <div className="border border-border rounded-lg overflow-hidden bg-background shadow-sm mt-4">
                          <div className="overflow-x-auto">
                              <table className="w-full text-sm text-left">
                                  <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
                                      <tr>
                                          {isSelectionMode && <th className="w-12 px-4 py-3 text-center">Select</th>}
                                          <th className="w-16 px-4 py-3 text-center">Cover</th>
                                          <th className="px-4 py-3">Issue</th>
                                          <th className="px-4 py-3 text-center">Progress</th>
                                          <th className="px-4 py-3 text-right">Actions</th>
                                      </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border">
                                      {downloadedIssues.map((issue) => {
                                          const isSelected = activeIssue?.id === issue.id || selectedIssues.has(issue.id);
                                          const isRead = issue.isRead || (issue.readProgress || 0) >= 100;
                                          return (
                                              <tr 
                                                key={issue.id} 
                                                onClick={() => {
                                                    if (isSelectionMode) {
                                                        const next = new Set(selectedIssues);
                                                        if (next.has(issue.id)) next.delete(issue.id);
                                                        else next.add(issue.id);
                                                        setSelectedIssues(next);
                                                    } else {
                                                        setActiveIssue(issue);
                                                    }
                                                }} 
                                                className={`cursor-pointer transition-colors ${isSelected ? (isSelectionMode ? 'bg-primary/10' : 'bg-muted/50') : 'hover:bg-muted/50'}`}
                                              >
                                                  {isSelectionMode && (
                                                      <td className="px-4 py-3 text-center">
                                                          {selectedIssues.has(issue.id) ? <CheckSquare className="w-5 h-5 text-primary mx-auto" /> : <Square className="w-5 h-5 text-muted-foreground mx-auto" />}
                                                      </td>
                                                  )}
                                                  <td className="px-4 py-2">
                                                      <div className="w-10 h-14 bg-muted rounded overflow-hidden flex items-center justify-center shrink-0 border border-border relative">
                                                          {issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className={`w-full h-full object-cover ${isRead ? 'opacity-60' : ''}`} alt="" /> : <ImageIcon className="w-4 h-4 text-muted-foreground/50" />}
                                                          {isRead && <div className="absolute inset-0 flex items-center justify-center bg-green-500/20 z-20"><Check className="w-4 h-4 text-green-500 font-bold"/></div>}
                                                      </div>
                                                  </td>
                                                  <td className="px-4 py-3 font-bold">
                                                      <div className={`line-clamp-2 leading-tight ${isRead ? 'text-muted-foreground' : 'text-foreground'}`}>{issue.name}</div>
                                                      {issue.parsedNum !== null && <div className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</div>}
                                                  </td>
                                                  <td className="px-4 py-3 text-center">
                                                      {isRead ? <Badge className="bg-green-600 border-0 text-[9px] px-1 h-4"><Check className="w-3 h-3 mr-1"/> Read</Badge> : issue.readProgress > 0 ? <Badge className="bg-primary border-0 text-primary-foreground text-[9px] px-1 h-4">{Math.round(issue.readProgress)}%</Badge> : <span className="text-muted-foreground text-xs">-</span>}
                                                  </td>
                                                  <td className="px-4 py-3 text-right">
                                                      <div className="flex items-center justify-end gap-2">
                                                          {!isSelectionMode && (
                                                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-muted shrink-0" onClick={(e) => { e.stopPropagation(); handleToggleRead(issue, !isRead); }} title={isRead ? "Mark Unread" : "Mark Read"}>
                                                                  {isRead ? <EyeOff className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                                                              </Button>
                                                          )}
                                                          <Button size="sm" variant={isSelected && !isSelectionMode ? "default" : "outline"} className="h-8 text-[11px] font-black uppercase tracking-wider" asChild onClick={(e) => { if (isSelectionMode) { e.preventDefault(); } else { e.stopPropagation(); } }}>
                                                              <Link href={`/reader?path=${encodeURIComponent(issue.fullPath)}&series=${encodeURIComponent(folderPath || '')}`}>
                                                                  {getReadButtonLabel(issue)}
                                                              </Link>
                                                          </Button>
                                                          {canDownload && !isSelectionMode && <Button size="sm" variant="secondary" className="h-8 px-3 bg-muted hover:bg-muted/80 text-foreground border-border hidden sm:flex" asChild onClick={(e) => e.stopPropagation()}><a href={`/api/library/download?path=${encodeURIComponent(issue.fullPath)}`} download><Download className="w-4 h-4" /></a></Button>}
                                                          {isAdmin && !isSelectionMode && (
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

                  {/* BULK SELECTION FLOATING BAR */}
                  {isSelectionMode && (
                      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-background text-foreground px-4 sm:px-6 py-3 rounded-full shadow-[0_10px_40px_-10px_rgba(0,0,0,0.5)] flex items-center gap-3 sm:gap-4 z-50 animate-in slide-in-from-bottom-8 border border-border w-[95%] sm:w-auto overflow-x-auto">
                          <Button variant="ghost" size="sm" className="h-10 sm:h-8 shrink-0 hover:bg-muted text-foreground font-medium" onClick={() => {
                              if (selectedIssues.size === downloadedIssues.length) setSelectedIssues(new Set());
                              else setSelectedIssues(new Set(downloadedIssues.map(i => i.id)));
                          }}>
                              {selectedIssues.size === downloadedIssues.length && downloadedIssues.length > 0 ? "Deselect All" : "Select All"}
                          </Button>
                          <div className="h-5 w-px bg-border shrink-0" />
                          <span className="font-black whitespace-nowrap min-w-[60px] sm:min-w-[100px] text-center text-sm sm:text-base shrink-0">{selectedIssues.size} Selected</span>
                          
                          <div className="flex gap-2 shrink-0">
                              <Button size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedIssues.size > 0 ? 'text-foreground hover:bg-muted' : 'bg-muted text-muted-foreground cursor-not-allowed border-border'}`} disabled={selectedIssues.size === 0 || isBulkProcessing} onClick={() => handleBulkProgress(true)}>
                                  {isBulkProcessing ? <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 sm:mr-2" />} <span className="hidden sm:inline">Mark Read</span>
                              </Button>
                              <Button size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedIssues.size > 0 ? 'text-foreground hover:bg-muted' : 'bg-muted text-muted-foreground cursor-not-allowed border-border'}`} disabled={selectedIssues.size === 0 || isBulkProcessing} onClick={() => handleBulkProgress(false)}>
                                  {isBulkProcessing ? <Loader2 className="w-4 h-4 sm:mr-2 animate-spin" /> : <EyeOff className="w-4 h-4 sm:mr-2" />} <span className="hidden sm:inline">Mark Unread</span>
                              </Button>
                              
                              {isAdmin && (
                                  <Button size="sm" variant="outline" className={`h-10 sm:h-8 shadow-sm font-bold transition-all ${selectedIssues.size > 0 ? 'text-foreground hover:bg-muted' : 'bg-muted text-muted-foreground cursor-not-allowed border-border'}`} disabled={selectedIssues.size === 0 || isBulkProcessing} onClick={() => {
                                      // Populate local state with the exact objects selected
                                      const itemsToEdit = downloadedIssues.filter(i => selectedIssues.has(i.id)).map(i => ({
                                          id: i.id, number: i.parsedNum?.toString() || "", name: i.name || "", releaseDate: i.releaseDate || ""
                                      }));
                                      setBulkEditData(itemsToEdit);
                                      setBulkEditModalOpen(true);
                                  }}>
                                      <Edit className="w-4 h-4 sm:mr-2" /> <span className="hidden sm:inline">Bulk Edit</span>
                                  </Button>
                              )}
                          </div>
                      </div>
                  )}
              </div>

              {/* --- MISSING ISSUES SECTION --- */}
              {seriesInfo.cvId && (
                  <div className="space-y-6 pt-4 border-t-2 border-border">
                      <h4 className="font-black flex items-center gap-2 text-xl text-muted-foreground opacity-80 tracking-tight"><CloudOff className="w-6 h-6"/> Missing Issues ({missingIssues.length})</h4>
                      
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
                                      <div key={issue.id} onClick={() => setActiveIssue(issue)} className="flex gap-4 p-4 bg-muted/30 border border-border/50 rounded-xl shadow-sm opacity-80 hover:opacity-100 transition-all cursor-pointer">
                                        <div className="w-20 h-28 shrink-0 rounded-md overflow-hidden bg-muted border border-border grayscale">{issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-8 h-8 m-auto mt-10 text-muted-foreground/50" />}</div>
                                        <div className="flex flex-col justify-between flex-1 py-1 min-w-0">
                                            <div><h5 className="font-bold text-base line-clamp-2 text-foreground leading-tight">{issue.name}</h5><span className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</span></div>
                                            <div className="flex items-center gap-2 mt-3">{isAlreadyRequested ? <Button size="sm" variant="secondary" disabled className="flex-1 h-9 bg-green-50 text-green-700 dark:bg-green-900/20 border-green-200 opacity-100 cursor-not-allowed"><Check className="w-4 h-4 mr-2"/> Queued</Button> : <Button size="sm" variant="outline" className="flex-1 h-9 font-black text-[10px] border-border hover:bg-muted uppercase tracking-wider" onClick={(e) => { e.stopPropagation(); handleRequestMissing(issue); }} disabled={isRequesting}>{isRequesting ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <CloudDownload className="w-4 h-4 mr-2"/>}Request</Button>}</div>
                                        </div>
                                      </div>
                                  );
                              })}
                          </div>
                      ) : (
                          <div className="border border-border rounded-lg overflow-hidden bg-background shadow-sm mt-4 pb-10">
                              <div className="overflow-x-auto">
                                  <table className="w-full text-sm text-left">
                                      <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
                                          <tr>
                                              <th className="w-16 px-4 py-3 text-center">Cover</th>
                                              <th className="px-4 py-3">Issue</th>
                                              <th className="px-4 py-3 text-right">Actions</th>
                                          </tr>
                                      </thead>
                                      <tbody className="divide-y divide-border">
                                          {missingIssues.map((issue) => {
                                              const isRequesting = requestingIds.has(issue.id);
                                              const isAlreadyRequested = requestedIds.has(issue.id);
                                              return (
                                                  <tr key={issue.id} onClick={() => setActiveIssue(issue)} className={`cursor-pointer transition-colors ${requestingIds.has(issue.id) ? 'opacity-50' : 'hover:bg-muted/50'}`}>
                                                      <td className="px-4 py-2">
                                                          <div className="w-10 h-14 bg-muted rounded overflow-hidden flex items-center justify-center shrink-0 border border-border grayscale relative">
                                                              {issue.coverUrl || seriesInfo.cover ? <img src={issue.coverUrl || seriesInfo.cover} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-4 h-4 text-muted-foreground/50" />}
                                                          </div>
                                                      </td>
                                                      <td className="px-4 py-3 font-bold">
                                                          <div className="line-clamp-2 leading-tight text-foreground">{issue.name}</div>
                                                          {issue.parsedNum !== null && <div className="text-[10px] mt-1 font-black text-muted-foreground uppercase tracking-widest">Issue #{issue.parsedNum}</div>}
                                                      </td>
                                                      <td className="px-4 py-3 text-right">
                                                          {isAlreadyRequested ? (
                                                              <Button size="sm" variant="secondary" disabled className="h-8 bg-green-50 text-green-700 dark:bg-green-900/20 border-green-200 opacity-100 cursor-not-allowed">
                                                                  <Check className="w-3.5 h-3.5 mr-1"/> Requested
                                                              </Button>
                                                          ) : (
                                                              <Button size="sm" variant="outline" className="h-8 font-bold border-border hover:bg-muted text-[10px] uppercase tracking-wider" onClick={(e) => { e.stopPropagation(); handleRequestMissing(issue); }} disabled={isRequesting}>
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
          <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col bg-background border-border">
              <DialogHeader><DialogTitle>Match Series</DialogTitle></DialogHeader>
              <form onSubmit={(e) => performSearch(e, false)} className="flex gap-2">
                  <Select value={searchProvider} onValueChange={setSearchProvider}>
                      <SelectTrigger className="w-[140px] bg-background border-border shrink-0">
                          <SelectValue placeholder="Source" />
                      </SelectTrigger>
                      <SelectContent>
                          <SelectItem value="COMICVINE">ComicVine</SelectItem>
                          <SelectItem value="MANGADEX">MangaDex</SelectItem>
                      </SelectContent>
                  </Select>
                  <Input placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="bg-background border-border w-full" />
                  <Button type="submit" disabled={isSearching}><Search className="w-4 h-4" /></Button>
              </form>
              
              <div className="flex-1 overflow-y-auto mt-4 pb-4 px-1">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {searchResults.map((item) => (
                          <div key={item.id} className="cursor-pointer space-y-2 group flex flex-col" onClick={() => handleMatch(item)}>
                              <div className="aspect-[2/3] bg-muted rounded-lg overflow-hidden border border-border relative shadow-sm">
                                  {item.image && <img src={getImageUrl(item.image) || ""} className="object-cover w-full h-full" alt="" />}
                                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                      <Button size="sm" className="font-bold shadow-lg" disabled={isMatching}>
                                          {isMatching ? <Loader2 className="animate-spin w-4 h-4" /> : "Select"}
                                      </Button>
                                  </div>
                              </div>
                              <div className="flex flex-col items-center text-center px-1">
                                  <h4 className="text-xs font-black line-clamp-1 text-foreground" title={item.name}>{item.name}</h4>
                                  <span className="text-[10px] font-bold text-muted-foreground line-clamp-1" title={item.publisher}>{item.publisher || "Unknown"}</span>
                                  <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mt-0.5">
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
          <DialogContent className="sm:max-w-[450px] bg-background border-border">
              <DialogHeader><DialogTitle>Edit Series Info</DialogTitle></DialogHeader>
              <div className="grid gap-4 py-4">
                  <div className="grid gap-2"><Label>Source Folder Path</Label><div className="flex gap-2"><Input readOnly value={seriesInfo.path || folderPath!} className="bg-muted border-border text-xs truncate text-muted-foreground" /><Button variant="secondary" size="icon" onClick={copyToClipboard} className="border border-border hover:bg-muted">{copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}</Button></div></div>
                  <div className="grid gap-2"><Label>ComicVine ID</Label><Input type="number" value={editForm.cvId} onChange={(e) => setEditForm({...editForm, cvId: e.target.value})} className="bg-background border-border" /></div>
                  <div className="grid gap-2"><Label>Publisher</Label><Input value={editForm.publisher} onChange={(e) => setEditForm({...editForm, publisher: e.target.value})} className="bg-background border-border" /></div>
                  <div className="grid gap-2"><Label>Series Name</Label><Input value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})} className="bg-background border-border" /></div>
                  <div className="grid gap-2"><Label>Year</Label><Input value={editForm.year} onChange={(e) => setEditForm({...editForm, year: e.target.value})} className="bg-background border-border" /></div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                      <div className="flex items-center gap-2 bg-muted p-3 rounded-lg border border-border">
                          <Switch id="monitored" checked={editForm.monitored} onCheckedChange={v => setEditForm({...editForm, monitored: v})} />
                          <Label htmlFor="monitored" className="cursor-pointer">Monitor Series</Label>
                      </div>
                      <div className="flex items-center gap-2 bg-muted p-3 rounded-lg border border-border">
                          <Switch id="isManga" checked={editForm.isManga} onCheckedChange={v => setEditForm({...editForm, isManga: v})} />
                          <Label htmlFor="isManga" className="cursor-pointer">Flag as Manga</Label>
                      </div>
                  </div>
              </div>
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEditModalOpen(false)} className="border-border hover:bg-muted">Cancel</Button><Button className="bg-primary font-bold hover:bg-primary/90 text-primary-foreground" onClick={handleManualEditSave} disabled={isSavingEdit}>{isSavingEdit ? <Loader2 className="animate-spin mr-2" /> : "Save Changes"}</Button></div>
          </DialogContent>
      </Dialog>

      {/* SPREADSHEET BULK EDITOR MODAL */}
      <Dialog open={bulkEditModalOpen} onOpenChange={setBulkEditModalOpen}>
          <DialogContent className="sm:max-w-4xl w-[95%] bg-background border-border rounded-xl">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-primary">
                      <LayoutGrid className="w-5 h-5" /> Bulk Issue Editor
                  </DialogTitle>
                  <DialogDescription>
                      Quickly edit the numbering, names, and release dates of the selected issues.
                  </DialogDescription>
              </DialogHeader>
              <div className="max-h-[60vh] overflow-y-auto border border-border rounded-md mt-4">
                  <table className="w-full text-sm text-left">
                      <thead className="bg-muted text-xs text-muted-foreground uppercase sticky top-0 z-10">
                          <tr>
                              <th className="px-4 py-3 w-[15%]">Number</th>
                              <th className="px-4 py-3 w-[55%]">Title / Name</th>
                              <th className="px-4 py-3 w-[30%]">Date (YYYY-MM-DD)</th>
                          </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                          {bulkEditData.map((row, idx) => (
                              <tr key={row.id} className="bg-background hover:bg-muted/30">
                                  <td className="p-2">
                                      <Input 
                                          value={row.number} 
                                          className="h-8 bg-transparent border-transparent hover:border-border focus:border-primary"
                                          onChange={(e) => {
                                              const nd = [...bulkEditData];
                                              nd[idx].number = e.target.value;
                                              setBulkEditData(nd);
                                          }} 
                                      />
                                  </td>
                                  <td className="p-2">
                                      <Input 
                                          value={row.name} 
                                          className="h-8 bg-transparent border-transparent hover:border-border focus:border-primary"
                                          onChange={(e) => {
                                              const nd = [...bulkEditData];
                                              nd[idx].name = e.target.value;
                                              setBulkEditData(nd);
                                          }} 
                                      />
                                  </td>
                                  <td className="p-2">
                                      <Input 
                                          value={row.releaseDate || ""} 
                                          placeholder="e.g. 2025-10-14"
                                          className="h-8 bg-transparent border-transparent hover:border-border focus:border-primary"
                                          onChange={(e) => {
                                              const nd = [...bulkEditData];
                                              nd[idx].releaseDate = e.target.value;
                                              setBulkEditData(nd);
                                          }} 
                                      />
                                  </td>
                              </tr>
                          ))}
                      </tbody>
                  </table>
              </div>
              <DialogFooter>
                  <Button variant="outline" onClick={() => setBulkEditModalOpen(false)} disabled={isBulkProcessing} className="border-border hover:bg-muted">Cancel</Button>
                  <Button onClick={handleSpreadsheetSave} disabled={isBulkProcessing} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                      {isBulkProcessing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                      Save All Changes
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={deleteModalOpen} onOpenChange={setDeleteModalOpen}>
          <DialogContent className="sm:max-w-[425px] bg-background border-border">
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
                  <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={isDeleting} className="border-border hover:bg-muted">Cancel</Button>
                  <Button variant="destructive" onClick={handleDeleteSeries} disabled={isDeleting}>
                      {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />} Delete
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={deleteIssueModalOpen} onOpenChange={setDeleteIssueModalOpen}>
          <DialogContent className="sm:max-w-[425px] bg-background border-border">
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
                  <Button variant="outline" onClick={() => setDeleteIssueModalOpen(false)} disabled={isDeletingIssue} className="border-border hover:bg-muted">Cancel</Button>
                  <Button variant="destructive" onClick={handleDeleteIssue} disabled={isDeletingIssue}>
                      {isDeletingIssue ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />} Delete
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      <Dialog open={reportModalOpen} onOpenChange={setReportModalOpen}>
          <DialogContent className="sm:max-w-[425px] bg-background border-border">
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
                      className="h-32 bg-background border-border"
                  />
              </div>
              <DialogFooter>
                  <Button variant="outline" onClick={() => setReportModalOpen(false)} disabled={isSubmittingReport} className="border-border hover:bg-muted">Cancel</Button>
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
    <Suspense fallback={<div className="p-10 text-center text-muted-foreground">Loading series data...</div>}>
      <SeriesContent />
    </Suspense>
  )
}