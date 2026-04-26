// src/components/comic-grid.tsx
"use client"

import { useState, useEffect } from "react"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Loader2, ChevronLeft, ChevronRight, Plus, Info, Calendar, Paintbrush, PenTool, Image as ImageIcon, ExternalLink, Layers, Download, CheckCircle2, Clock, Users, Globe, Activity, Library, FileCheck, Tags, BookMarked, MapPin, Shield } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogHeader } from "@/components/ui/dialog"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { Search as SearchIcon } from "lucide-react"
import { InteractiveSearchModal } from "./interactive-search-modal"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface Comic {
  id: number;
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
  colorists?: string[];
  letterers?: string[];
  characters?: string[];
  genres?: string[];
  storyArcs?: string[];
  teams?: string[];
  locations?: string[];
  isVolume?: boolean;
  volumeName?: string;
}

interface Props {
  title: string;
  type: 'popular' | 'new';
  refreshSignal?: number;
}

type StatusType = 'LIBRARY_MONITORED' | 'LIBRARY_UNMONITORED' | 'ISSUE_OWNED' | 'REQUESTED' | 'PENDING_APPROVAL' | null;

function ComicGridSkeleton({ count = 14 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
      {[...Array(count)].map((_, i) => (
        <div key={i} className="aspect-[2/3] bg-muted animate-pulse rounded-lg shadow-sm" />
      ))}
    </div>
  );
}

export function ComicGrid({ title, type, refreshSignal = 0 }: Props) {
  const { data: session } = useSession()
  const [comics, setComics] = useState<Comic[]>([])
  const [loading, setLoading] = useState(true)
  
  const [offsets, setOffsets] = useState<number[]>([0])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)

  const [limit, setLimit] = useState(14)
  const [isInitialized, setIsInitialized] = useState(false)

  const [requestingTarget, setRequestingTarget] = useState<string | null>(null)
  const [requestedVolumes, setRequestedVolumes] = useState<Set<number>>(new Set())
  const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set())
  
  const [ownedSeries, setOwnedSeries] = useState<Set<number>>(new Set())
  const [monitoredSeries, setMonitoredSeries] = useState<Set<number>>(new Set())
  const [ownedIssues, setOwnedIssues] = useState<Set<number>>(new Set())
  const [activeRequests, setActiveRequests] = useState<any[]>([])

  const [selectedComic, setSelectedComic] = useState<Comic | null>(null)
  const [relatedIssues, setRelatedIssues] = useState<Comic[]>([])
  const [loadingRelated, setLoadingRelated] = useState(false)
  const { toast } = useToast()
  const [interactiveQuery, setInteractiveQuery] = useState<{ query: string, type: 'volume' | 'issue' } | null>(null)
  const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string, directSource?: 'getcomics' } | null>(null);

  useEffect(() => {
    const savedLimit = localStorage.getItem(`omnibus-grid-limit-${type}`);
    if (savedLimit) setLimit(parseInt(savedLimit));
    setIsInitialized(true);
  }, [type]);

  const handleLimitChange = (val: string) => {
    const newLimit = parseInt(val);
    setLimit(newLimit);
    setOffsets([0]);
    setCurrentIndex(0);
    localStorage.setItem(`omnibus-grid-limit-${type}`, val);
  };

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
  }, [refreshSignal]);

  const getVolumeStatus = (volumeId: number, name: string): StatusType => {
      if (ownedSeries.has(volumeId)) return monitoredSeries.has(volumeId) ? 'LIBRARY_MONITORED' : 'LIBRARY_UNMONITORED';
      if (requestedVolumes.has(volumeId)) return 'REQUESTED';
      
      const activeReqs = activeRequests.filter(r => r.volumeId === volumeId.toString());
      if (activeReqs.length > 0) {
          const allCompleted = activeReqs.every(r => ['IMPORTED', 'COMPLETED'].includes(r.status));
          if (allCompleted) return monitoredSeries.has(volumeId) ? 'LIBRARY_MONITORED' : 'LIBRARY_UNMONITORED';
          if (activeReqs.some(r => r.status === 'PENDING_APPROVAL')) return 'PENDING_APPROVAL';
      }
      return null;
  }

  const getIssueStatus = (issueId: number | string, volumeId: number | string, issueName: string): StatusType => {
      if (ownedIssues.has(Number(issueId))) return 'ISSUE_OWNED';
      if (requestedIssues.has(issueName)) return 'REQUESTED';

      const req = activeRequests.find(r => String(r.volumeId) === String(volumeId) && r.name === issueName);
      if (req) {
          if (['IMPORTED', 'COMPLETED'].includes(req.status)) return 'ISSUE_OWNED';
          if (req.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
          return 'REQUESTED';
      }
      return null;
  }

  useEffect(() => {
    if (!isInitialized) return;
    setLoading(true)
    const isRefresh = refreshSignal > 0;
    const url = `/api/discover?type=${type}&offset=${offsets[currentIndex]}&limit=${limit}${isRefresh ? '&refresh=true' : ''}`;
    
    fetch(url, { cache: isRefresh ? 'no-store' : 'default' })
      .then(res => res.json())
      .then(data => { 
          if (data.results) setComics(data.results);
          setNextOffset(data.nextOffset || null);
      })
      .finally(() => setLoading(false))
  }, [currentIndex, type, refreshSignal, limit, isInitialized, offsets])

  useEffect(() => {
    if (!selectedComic?.id) return;
    
    fetch(`/api/issue-details?id=${selectedComic.id}&type=issue&_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        if (data && !data.error) {
          setSelectedComic(prev => {
            if (prev?.id !== data.id) return prev; 
            return {
                ...prev,
                ...data,
                name: (data.name && data.name !== "Unknown") ? data.name : prev?.name,
                publisher: (data.publisher && data.publisher !== 'Unknown') ? data.publisher : prev?.publisher,
                year: (data.year && data.year !== '????') ? data.year : prev?.year,
                image: data.image || prev?.image,
                description: data.description?.trim() ? data.description : prev?.description
            } as Comic;
          });
        }
      });
  }, [selectedComic?.id]);

  useEffect(() => {
    if (!selectedComic?.volumeId) { setRelatedIssues([]); return; }
    setLoadingRelated(true)
    fetch(`/api/series-issues?volumeId=${selectedComic.volumeId}`)
      .then(res => res.json())
      .then(data => {
        if (data.results) {
           const sorted = data.results.sort((a: any, b: any) => (parseFloat(b.issueNumber) || 0) - (parseFloat(a.issueNumber) || 0));
           setRelatedIssues(sorted);
        }
      })
      .finally(() => setLoadingRelated(false))
  }, [selectedComic?.volumeId])

  const handleRequest = async (id: number, name: string, image: string, year: string, type: 'volume' | 'issue', publisher: string, monitored: boolean = false, directSource?: string, issueNumber?: string) => {
    if (!name || name === "Unknown" || name === "undefined") {
        toast({ title: "Request Failed", description: "Could not resolve series name. Please try interactive search.", variant: "destructive" });
        return;
    }

    const exactIssueName = (type === 'issue' && !name.includes(`#${issueNumber || "1"}`)) ? `${name} #${issueNumber || "1"}` : name;
    const targetKey = type === 'volume' ? `vol-${id}` : `iss-${exactIssueName}`;
    
    setRequestingTarget(targetKey);
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            cvId: id, 
            name, 
            year, 
            publisher: publisher || "Unknown", 
            image, 
            type, 
            monitored, 
            directSource,
            issueNumber: issueNumber || (type === 'issue' ? "1" : undefined)
        })
      });

      if (res.ok) {
          toast({ title: "Success", description: `${exactIssueName} added to queue.` })
          
          if (type === 'volume') {
              setRequestedVolumes(prev => new Set(prev).add(id));
          } else {
              setRequestedIssues(prev => new Set(prev).add(exactIssueName));
              setActiveRequests(prev => [
                  ...prev, 
                  { 
                      volumeId: id.toString(), 
                      name: exactIssueName, 
                      status: (session?.user as any)?.role === 'ADMIN' ? 'PENDING' : 'PENDING_APPROVAL' 
                  }
              ]);
          }
      }
    } finally { setRequestingTarget(null) }
  }

  const handleNext = () => {
    if (currentIndex === offsets.length - 1 && nextOffset !== null) {
        setOffsets(prev => [...prev, nextOffset]);
    }
    setCurrentIndex(prev => prev + 1);
  }

  const handlePrev = () => {
    setCurrentIndex(prev => Math.max(0, prev - 1));
  }

  const getDisplayDescription = () => {
    if (selectedComic?.description?.trim() && selectedComic.description !== "No description available.") {
        return selectedComic.description;
    }
    if (relatedIssues && relatedIssues.length > 0) {
      const sortedCv = [...relatedIssues].sort((a, b) => {
        const numA = parseFloat(a.issueNumber || "9999");
        const numB = parseFloat(b.issueNumber || "9999");
        return numA - numB;
      });
      const fallback = sortedCv.find(cv => cv.description?.trim() && cv.description !== "No description available.");
      if (fallback) return fallback.description;
    }
    return null;
  };

  const displayDescription = getDisplayDescription();
  const hasCreators = selectedComic && (
    (selectedComic.writers?.length ?? 0) > 0 || 
    (selectedComic.artists?.length ?? 0) > 0 ||
    (selectedComic.coverArtists?.length ?? 0) > 0 ||
    (selectedComic.colorists?.length ?? 0) > 0 ||
    (selectedComic.letterers?.length ?? 0) > 0
  );
  
  const seriesBaseName = selectedComic?.volumeName || (selectedComic?.name ? selectedComic.name.split(' #')[0] : "Unknown");

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">{title}</h2>
        <div className="flex items-center gap-3">
            <Select value={limit.toString()} onValueChange={handleLimitChange}>
                <SelectTrigger className="h-10 sm:h-8 w-[100px] text-sm sm:text-xs font-medium bg-background border-border shadow-sm">
                    <SelectValue placeholder="Show 14" />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                    <SelectItem value="7">Show 7</SelectItem>
                    <SelectItem value="14">Show 14</SelectItem>
                    <SelectItem value="21">Show 21</SelectItem>
                    <SelectItem value="28">Show 28</SelectItem>
                    <SelectItem value="42">Show 42</SelectItem>
                </SelectContent>
            </Select>

            <div className="flex items-center gap-2 bg-background p-1 rounded-md shadow-sm border border-border">
                <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-6 sm:w-6 hover:bg-muted" onClick={handlePrev} disabled={currentIndex === 0 || loading}><ChevronLeft className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
                <span className="text-sm sm:text-xs font-mono w-4 text-center">{currentIndex + 1}</span>
                <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-6 sm:w-6 hover:bg-muted" onClick={handleNext} disabled={loading || (currentIndex === offsets.length - 1 && nextOffset === null)}><ChevronRight className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
            </div>
        </div>
      </div>
      
      {(!isInitialized || loading) ? (
        <ComicGridSkeleton count={limit} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
          {comics.map((comic) => {
            const status = comic.issueNumber ? getIssueStatus(comic.id, comic.volumeId, comic.name) : getVolumeStatus(comic.volumeId, comic.name.split(' #')[0]);
            return (
            <div 
                key={comic.id}
                role="button"
                tabIndex={0}
                className="text-left w-full group relative aspect-[2/3] bg-muted rounded-lg overflow-hidden shadow-sm hover:scale-105 transition-all cursor-pointer border border-border focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none" 
                onClick={() => setSelectedComic(comic)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedComic(comic);
                    }
                }}
                aria-label={`View details for ${comic.name}`}
            >
                <img src={comic.image} alt={comic.name} loading="lazy" className="object-cover w-full h-full relative z-0" />
                
                {status === 'LIBRARY_MONITORED' && (<div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 shadow-lg z-30" title="Monitored"><Activity className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                {status === 'LIBRARY_UNMONITORED' && (<div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-1 shadow-lg z-30" title="In Library"><Library className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                {status === 'ISSUE_OWNED' && (<div className="absolute top-2 right-2 bg-emerald-500 text-white rounded-full p-1 shadow-lg z-30" title="In Library"><FileCheck className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                
                {status === 'REQUESTED' && (<div className="absolute top-2 right-2 bg-orange-500 text-white rounded-full p-1 shadow-lg z-30" title="Requested"><Clock className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                {status === 'PENDING_APPROVAL' && (<div className="absolute top-2 right-2 bg-yellow-500 text-white rounded-full p-1 shadow-lg z-30" title="Pending Admin Approval"><Clock className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                
                <div className="absolute inset-0 bg-black/40 hidden sm:block opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none" />

                <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-transparent opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 pb-4 text-center gap-1 z-30 pointer-events-none">
                    <h3 className="text-white font-extrabold text-sm sm:text-base line-clamp-2 leading-tight drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">{comic.name}</h3>
                    <p className="text-primary font-black text-[11px] sm:text-xs drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] uppercase tracking-widest">{comic.year}</p>
                </div>
                
                <div className="absolute inset-0 hidden sm:flex opacity-0 group-hover:opacity-100 transition-opacity items-center justify-center z-40 pointer-events-none">
                  <Button size="sm" className="font-bold shadow-lg bg-primary hover:bg-primary/90 text-primary-foreground pointer-events-auto transition-transform group-hover:scale-110" tabIndex={-1}>Details</Button>
                </div>
            </div>
          )})}
        </div>
      )}

      <Dialog open={!!selectedComic} onOpenChange={(open) => !open && setSelectedComic(null)}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0 bg-background border-border rounded-xl w-[95%]">
            {selectedComic && (
                <>
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                    <div className="mb-4 sm:mb-6">
                         <DialogTitle className="text-2xl sm:text-3xl font-bold leading-tight mb-2 text-foreground pr-8">{selectedComic.name}</DialogTitle>
                         <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                           <Badge variant="outline" className="gap-1 font-normal border-border text-muted-foreground"><Calendar className="w-3 h-3"/> {selectedComic.year}</Badge>
                           {selectedComic.publisher && selectedComic.publisher !== 'Unknown' && (<span className="text-sm font-bold text-muted-foreground">{selectedComic.publisher}</span>)}
                         </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-8 mb-8">
                        <div className="space-y-5 flex flex-col items-center md:items-stretch">
                            <div className="relative aspect-[2/3] w-[200px] md:w-[240px] mx-auto rounded-lg overflow-hidden border bg-muted shadow-md border-border transition-colors duration-300">
                                <img src={selectedComic.image} alt={selectedComic.name} className="absolute inset-0 w-full h-full object-contain" />
                            </div>
                            
                            {(() => {
                                const issueTargetName = selectedComic.isVolume ? `${seriesBaseName} #${selectedComic.issueNumber || "1"}` : selectedComic.name;
                                
                                const volStatus = getVolumeStatus(selectedComic.volumeId, seriesBaseName);
                                const issueStatus = getIssueStatus(selectedComic.id, selectedComic.volumeId, issueTargetName);
                                
                                const isVolOwned = volStatus === 'LIBRARY_MONITORED' || volStatus === 'LIBRARY_UNMONITORED';
                                const isIssueOwned = issueStatus === 'ISSUE_OWNED';
                                const overallStatus = selectedComic.isVolume ? volStatus : issueStatus;

                                return (
                                  <div className="flex flex-col gap-2.5 sm:gap-3 w-full max-w-[300px] mx-auto md:max-w-none mt-2">
                                      {/* VOLUME BUTTONS */}
                                      {volStatus === 'PENDING_APPROVAL' || volStatus === 'REQUESTED' ? (
                                          <Button className="w-full gap-1.5 shadow-sm h-auto min-h-[2.5rem] py-1.5 text-sm font-bold whitespace-normal" variant="default" disabled>
                                              {volStatus === 'PENDING_APPROVAL' && <><Clock className="w-4 h-4 text-yellow-500 shrink-0" /> <span className="leading-tight">Pending Approval</span></>}
                                              {volStatus === 'REQUESTED' && <><Clock className="w-4 h-4 text-orange-500 shrink-0" /> <span className="leading-tight">Requested</span></>}
                                          </Button>
                                      ) : (
                                          <Button 
                                              className={`w-full gap-1.5 shadow-sm h-auto min-h-[2.5rem] py-1.5 text-sm font-bold whitespace-normal ${isVolOwned ? 'bg-green-600 hover:bg-green-700 text-white' : ''}`} 
                                              variant="default" 
                                              onClick={() => setMonitorPrompt({ id: selectedComic.volumeId, name: seriesBaseName, image: selectedComic.image, year: selectedComic.year, publisher: selectedComic.publisher || 'Unknown', directSource: undefined })} 
                                              disabled={requestingTarget === `vol-${selectedComic.volumeId}`}
                                          >
                                              {requestingTarget === `vol-${selectedComic.volumeId}` ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : (
                                                  isVolOwned ? <><Download className="w-4 h-4 shrink-0" /> <span className="leading-tight text-center">Request Missing</span></> : <><Plus className="w-4 h-4 shrink-0" /> <span className="leading-tight text-center">Request Series</span></>
                                              )}
                                          </Button>
                                      )}
                                      
                                      {/* ISSUE BUTTONS */}
                                      {issueStatus === 'PENDING_APPROVAL' || issueStatus === 'REQUESTED' || isIssueOwned ? (
                                          <Button className={`w-full gap-1.5 shadow-sm h-auto min-h-[2.5rem] py-1.5 text-sm font-bold border-border hover:bg-muted text-foreground whitespace-normal`} variant="outline" disabled>
                                              {isIssueOwned && <><FileCheck className="w-4 h-4 text-emerald-500 shrink-0" /> <span className="leading-tight">In Library</span></>}
                                              {issueStatus === 'PENDING_APPROVAL' && <><Clock className="w-4 h-4 text-yellow-500 shrink-0" /> <span className="leading-tight">Pending Approval</span></>}
                                              {issueStatus === 'REQUESTED' && <><Clock className="w-4 h-4 text-orange-500 shrink-0" /> <span className="leading-tight">Requested</span></>}
                                          </Button>
                                      ) : (
                                          <Button 
                                             className="w-full gap-1.5 shadow-sm h-auto min-h-[2.5rem] py-1.5 text-sm font-bold bg-primary/10 text-primary border-primary/30 hover:bg-primary/20 whitespace-normal" 
                                             variant="outline" 
                                             onClick={() => handleRequest(selectedComic.volumeId, selectedComic.isVolume ? seriesBaseName : selectedComic.name, selectedComic.image, selectedComic.year, 'issue', selectedComic.publisher, false, undefined, selectedComic.issueNumber)} 
                                             disabled={requestingTarget === `iss-${issueTargetName}`}
                                          >
                                              {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <><Download className="w-4 h-4 shrink-0" /> <span className="leading-tight text-center">Request Issue</span></>}
                                          </Button>
                                      )}
                                      
                                      <Button 
                                        variant="outline" 
                                        className="w-full gap-1.5 border-dashed shadow-sm h-auto min-h-[2.5rem] py-1.5 text-sm font-bold border-border hover:bg-muted text-foreground whitespace-normal" 
                                        onClick={() => setInteractiveQuery({ query: selectedComic.isVolume ? seriesBaseName : selectedComic.name, type: selectedComic.isVolume ? 'issue' : 'volume' })}
                                        disabled={(!selectedComic.isVolume && isIssueOwned) || overallStatus === 'PENDING_APPROVAL' || overallStatus === 'REQUESTED'}
                                      >
                                          {overallStatus === 'PENDING_APPROVAL' ? (
                                              <><Clock className="w-4 h-4 text-yellow-500 shrink-0" /> <span className="leading-tight">Pending Approval</span></>
                                          ) : overallStatus === 'REQUESTED' ? (
                                              <><Clock className="w-4 h-4 text-orange-500 shrink-0" /> <span className="leading-tight">Requested</span></>
                                          ) : (!selectedComic.isVolume && isIssueOwned) ? (
                                              <><FileCheck className="w-4 h-4 text-emerald-500 shrink-0" /> <span className="leading-tight">In Library</span></>
                                          ) : (
                                              <><SearchIcon className="w-4 h-4 text-primary shrink-0" /> <span className="leading-tight">Interactive Search</span></>
                                          )}
                                      </Button>
                                  </div>
                                );
                            })()}

                        </div>
                        <div className="space-y-6">
                             {hasCreators && (
                                <div className="grid grid-cols-2 gap-4 bg-muted/50 p-4 rounded-lg border border-border transition-colors duration-300">
                                    {selectedComic.writers && selectedComic.writers.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Writer</p><p className="text-sm font-medium text-foreground">{selectedComic.writers.join(", ")}</p></div>)}
                                    {selectedComic.artists && selectedComic.artists.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Artist</p><p className="text-sm font-medium text-foreground">{selectedComic.artists.join(", ")}</p></div>)}
                                    {selectedComic.coverArtists && selectedComic.coverArtists.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><ImageIcon className="w-3 h-3" /> Cover Artist</p><p className="text-sm font-medium text-foreground">{selectedComic.coverArtists.join(", ")}</p></div>)}
                                    {selectedComic.colorists && selectedComic.colorists.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Colorist</p><p className="text-sm font-medium text-foreground">{selectedComic.colorists.join(", ")}</p></div>)}
                                    {selectedComic.letterers && selectedComic.letterers.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Letterer</p><p className="text-sm font-medium text-foreground">{selectedComic.letterers.join(", ")}</p></div>)}
                                </div>
                             )}

                             {selectedComic.characters && selectedComic.characters.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Users className="w-4 h-4"/> Characters</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedComic.characters.map((char: string) => (
                                            <Badge key={char} variant="secondary" className="font-medium text-[10px] bg-muted text-foreground border-border hover:bg-muted/80">{char}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             {selectedComic.teams && selectedComic.teams.length > 0 && (
                                <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Shield className="w-4 h-4 text-primary"/> Teams</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedComic.teams.map((team: string) => (
                                            <Badge key={team} variant="secondary" className="font-medium text-[10px] bg-primary/5 text-primary border-primary/20 hover:bg-primary/10">{team}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             {selectedComic.locations && selectedComic.locations.length > 0 && (
                                <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><MapPin className="w-4 h-4 text-primary"/> Locations</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedComic.locations.map((loc: string) => (
                                            <Badge key={loc} variant="outline" className="font-medium text-[10px] bg-background text-muted-foreground border-border">{loc}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             {selectedComic.genres && selectedComic.genres.length > 0 && (
                                 <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                     <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Tags className="w-4 h-4 text-primary"/> Concepts</h4>
                                     <div className="flex flex-wrap gap-1.5">
                                         {selectedComic.genres.map((genre: string) => (
                                             <Badge key={genre} variant="outline" className="font-medium text-[10px] bg-background text-muted-foreground border-border hover:text-foreground">{genre}</Badge>
                                         ))}
                                     </div>
                                 </div>
                             )}

                             {selectedComic.storyArcs && selectedComic.storyArcs.length > 0 && (
                                 <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                     <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><BookMarked className="w-4 h-4 text-primary"/> Story Arcs</h4>
                                     <div className="flex flex-wrap gap-1.5">
                                         {selectedComic.storyArcs.map((arc: string) => (
                                             <Badge key={arc} className="font-medium text-[10px] bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">{arc}</Badge>
                                         ))}
                                     </div>
                                 </div>
                             )}

                             <div className="space-y-2">
                                <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Info className="w-4 h-4"/> Synopsis</h4>
                                <div className="text-sm text-muted-foreground leading-relaxed p-4 bg-muted/50 rounded-md border border-border min-h-[100px] break-words transition-colors duration-300">
                                    {displayDescription || <span className="italic opacity-70">No synopsis available.</span>}
                                </div>
                             </div>
                        </div>
                    </div>
                    <div className="space-y-4 pt-4 border-t border-border">
                        <h4 className="font-semibold flex items-center gap-2 text-base sm:text-lg text-foreground"><Layers className="w-4 h-4 sm:w-5 h-5"/> More in this Series</h4>
                        <div className="w-full">
                            {loadingRelated ? (<div className="flex gap-3 sm:gap-4 overflow-hidden">{[1,2,3,4,5].map(i => (<div key={i} className="w-[120px] aspect-[2/3] bg-muted animate-pulse rounded-md border border-border" />))}</div>) : relatedIssues.length > 0 ? (
                                <ScrollArea className="w-full whitespace-nowrap pb-4">
                                    <div className="flex w-max gap-4 px-1">
                                        {relatedIssues.map(issue => {
                                            const relIssueTargetName = issue.name;
                                            const relIssueStatus = getIssueStatus(issue.id, selectedComic.volumeId, relIssueTargetName);
                                            
                                            return (
                                            <div 
                                                key={issue.id} 
                                                role="button"
                                                tabIndex={0}
                                                className="w-[110px] sm:w-[130px] shrink-0 group/issue cursor-pointer relative text-left focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none rounded-md"
                                                onClick={() => {
                                                    setSelectedComic({
                                                        ...issue,
                                                        volumeId: selectedComic.volumeId,
                                                        publisher: selectedComic.publisher,
                                                        issueNumber: issue.issueNumber,
                                                        description: undefined,
                                                        writers: undefined,
                                                        artists: undefined,
                                                        characters: undefined
                                                    } as Comic);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                        e.preventDefault();
                                                        setSelectedComic({
                                                            ...issue,
                                                            volumeId: selectedComic.volumeId,
                                                            publisher: selectedComic.publisher,
                                                            issueNumber: issue.issueNumber,
                                                            description: undefined,
                                                            writers: undefined,
                                                            artists: undefined,
                                                            characters: undefined
                                                        } as Comic);
                                                    }
                                                }}
                                                aria-label={`View details for ${issue.name}`}
                                              >
                                                <div className="relative aspect-[2/3] rounded-md overflow-hidden bg-muted border border-border shadow-sm hover:ring-2 hover:ring-primary transition-all">
                                                    <img src={issue.image} className="absolute inset-0 w-full h-full object-contain" alt={issue.name} />
                                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10 pointer-events-none" />
                                                    
                                                    <div className="absolute bottom-1 left-2 z-20 text-white text-[11px] font-black truncate drop-shadow-md">#{issue.issueNumber}</div>

                                                    {!relIssueStatus && (
                                                        <div className="absolute bottom-2 inset-x-2 z-30 opacity-100 sm:opacity-0 sm:group-hover/issue:opacity-100 transition-opacity flex justify-center items-center pointer-events-none">
                                                            <Button
                                                                size="icon"
                                                                className="h-8 w-8 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg pointer-events-auto"
                                                                disabled={requestingTarget === `iss-${relIssueTargetName}`}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    handleRequest(selectedComic.volumeId, issue.name, issue.image, issue.year, 'issue', selectedComic.publisher, false, undefined, issue.issueNumber);
                                                                }}
                                                                title="Request Issue"
                                                                tabIndex={-1}
                                                            >
                                                                {requestingTarget === `iss-${relIssueTargetName}` ? <Loader2 className="w-4 h-4 animate-spin"/> : <Download className="w-4 h-4"/>}
                                                            </Button>
                                                        </div>
                                                    )}

                                                    {relIssueStatus === 'REQUESTED' && (<div className="absolute top-1 left-1 bg-orange-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20">REQUESTED</div>)}
                                                    {relIssueStatus === 'PENDING_APPROVAL' && (<div className="absolute top-1 left-1 bg-yellow-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20" title="Pending Admin Approval">PENDING</div>)}
                                                    {relIssueStatus === 'ISSUE_OWNED' && (<div className="absolute top-1 left-1 bg-emerald-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20">IN LIBRARY</div>)}
                                                </div>
                                            </div>
                                        )})}
                                    </div>
                                    <ScrollBar orientation="horizontal" className="h-1.5" />
                                </ScrollArea>
                            ) : (<p className="text-sm text-muted-foreground">No individual issues found.</p>)}
                        </div>
                    </div>
                </div>
                <div className="p-3 sm:p-4 bg-background border-t border-border flex flex-col sm:flex-row gap-2 sm:justify-between z-10 shrink-0">
                        {selectedComic.siteUrl && (<Button variant="secondary" asChild className="h-12 sm:h-10 sm:mr-auto bg-background shadow-sm font-bold hover:bg-muted text-foreground border-border"><Link href={selectedComic.siteUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4 mr-2" /> View on ComicVine</Link></Button>)}
                        <Button variant="outline" className="text-foreground" onClick={() => setSelectedComic(null)}>Close</Button>
                </div>
                </>
            )}
        </DialogContent>
      </Dialog>
      {selectedComic && interactiveQuery && (
        <InteractiveSearchModal 
          isOpen={!!interactiveQuery} 
          onClose={() => setInteractiveQuery(null)} 
          initialQuery={interactiveQuery.query}
          comicData={{
            cvId: selectedComic.volumeId,
            year: selectedComic.year,
            publisher: selectedComic.publisher || 'Unknown',
            image: selectedComic.image,
            type: interactiveQuery.type
          }}
        />
      )}
      <Dialog open={!!monitorPrompt} onOpenChange={(open) => !open && setMonitorPrompt(null)}>
        <DialogContent className="sm:max-w-md bg-background border-border rounded-xl w-[95%]">
          <DialogHeader>
              <DialogTitle className="text-xl font-bold text-foreground">Monitor Series?</DialogTitle>
              <DialogDescription className="text-base text-muted-foreground mt-2">
                You are requesting the series <strong>{monitorPrompt?.name}</strong>. Would you like Omnibus to automatically monitor this series and download new issues as they are released in the future?
              </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-4 sm:mt-6">
            <Button className="w-full h-12 sm:h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, true, monitorPrompt.directSource);
                setMonitorPrompt(null);
            }}>
                Yes, Request & Monitor
            </Button>
            <Button variant="outline" className="w-full h-12 sm:h-10 font-bold border-primary/30 text-primary bg-primary/10 hover:bg-primary/20" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, false, monitorPrompt.directSource);
                setMonitorPrompt(null);
            }}>
                No, Just Request Current Issues
            </Button>
            <Button variant="ghost" className="w-full h-12 sm:h-10 font-bold text-muted-foreground" onClick={() => setMonitorPrompt(null)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}