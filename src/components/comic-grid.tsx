"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, ChevronLeft, ChevronRight, Plus, Info, Calendar, Paintbrush, PenTool, Image as ImageIcon, ExternalLink, Layers, Download, CheckCircle2, Clock, Users } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
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
  characters?: string[];
}

interface Props {
  title: string;
  type: 'popular' | 'new';
  refreshSignal?: number;
}

type StatusType = 'LIBRARY' | 'REQUESTED' | null;

function ComicGridSkeleton({ count = 14 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
      {[...Array(count)].map((_, i) => (
        <div key={i} className="aspect-[2/3] bg-slate-200 dark:bg-slate-800 animate-pulse rounded-lg shadow-sm" />
      ))}
    </div>
  );
}

export function ComicGrid({ title, type, refreshSignal = 0 }: Props) {
  const [comics, setComics] = useState<Comic[]>([])
  const [loading, setLoading] = useState(true)
  
  const [offsets, setOffsets] = useState<number[]>([0])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)

  const [limit, setLimit] = useState(14)
  const [isInitialized, setIsInitialized] = useState(false)

  const [requestingId, setRequestingId] = useState<number | null>(null)
  
  const [ownedSeries, setOwnedSeries] = useState<Set<number>>(new Set())
  const [ownedIssues, setOwnedIssues] = useState<Set<number>>(new Set())
  const [activeRequests, setActiveRequests] = useState<any[]>([])

  const [selectedComic, setSelectedComic] = useState<Comic | null>(null)
  const [relatedIssues, setRelatedIssues] = useState<Comic[]>([])
  const [loadingRelated, setLoadingRelated] = useState(false)
  const { toast } = useToast()
  const [interactiveQuery, setInteractiveQuery] = useState<{ query: string, type: 'volume' | 'issue' } | null>(null)
  const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string } | null>(null);

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
              setOwnedIssues(new Set(data.issues || []));
              setActiveRequests(data.requests || []);
          }
      });
  }, [currentIndex, selectedComic]);

  const getVolumeStatus = (volumeId: number, name: string): StatusType => {
      if (ownedSeries.has(volumeId)) return 'LIBRARY';
      const activeReqs = activeRequests.filter(r => r.volumeId === volumeId);
      if (activeReqs.length > 0) {
          const allCompleted = activeReqs.every(r => ['IMPORTED', 'COMPLETED'].includes(r.status));
          return allCompleted ? 'LIBRARY' : 'REQUESTED';
      }
      return null;
  }

  const getIssueStatus = (issueId: number, volumeId: number, issueName: string): StatusType => {
      if (ownedIssues.has(issueId)) return 'LIBRARY';
      const req = activeRequests.find(r => r.volumeId === volumeId && r.name === issueName);
      if (req) return ['IMPORTED', 'COMPLETED'].includes(req.status) ? 'LIBRARY' : 'REQUESTED';
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
    
    fetch(`/api/issue-details?id=${selectedComic.id}&type=issue`)
      .then(res => res.json())
      .then(data => {
        if (data && !data.error) {
          setSelectedComic(prev => {
            if (prev?.id !== data.id) return prev; 
            return {
                ...prev,
                ...data,
                name: data.name || prev?.name,
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

  const handleRequest = async (id: number, name: string, image: string, year: string, type: 'volume' | 'issue', publisher: string, monitored: boolean = false) => {
    setRequestingId(id)
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cvId: id, name, year, publisher: publisher || "Unknown", image, type, monitored })
      });
      if (res.ok) {
          toast({ title: "Success", description: `${name} added to queue.` })
          // Instant UI Update
          setActiveRequests(prev => [...prev, { volumeId: id, name: name, status: 'PENDING' }]);
      }
    } finally { setRequestingId(null) }
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

  const hasCreators = selectedComic && ((selectedComic.writers?.length ?? 0) > 0 || (selectedComic.artists?.length ?? 0) > 0);

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

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        <div className="flex items-center gap-3">
            <Select value={limit.toString()} onValueChange={handleLimitChange}>
                <SelectTrigger className="h-10 sm:h-8 w-[100px] text-sm sm:text-xs font-medium bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm">
                    <SelectValue placeholder="Show 14" />
                </SelectTrigger>
                <SelectContent className="dark:bg-slate-950 dark:border-slate-800">
                    <SelectItem value="7">Show 7</SelectItem>
                    <SelectItem value="14">Show 14</SelectItem>
                    <SelectItem value="21">Show 21</SelectItem>
                    <SelectItem value="28">Show 28</SelectItem>
                    <SelectItem value="42">Show 42</SelectItem>
                </SelectContent>
            </Select>

            <div className="flex items-center gap-2 bg-white dark:bg-slate-900 p-1 rounded-md shadow-sm border dark:border-slate-800">
                <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-6 sm:w-6 dark:hover:bg-slate-800" onClick={handlePrev} disabled={currentIndex === 0 || loading}><ChevronLeft className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
                <span className="text-sm sm:text-xs font-mono w-4 text-center">{currentIndex + 1}</span>
                <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-6 sm:w-6 dark:hover:bg-slate-800" onClick={handleNext} disabled={loading || (currentIndex === offsets.length - 1 && nextOffset === null)}><ChevronRight className="h-5 w-5 sm:h-4 sm:w-4" /></Button>
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
            <div key={comic.id} className="group relative aspect-[2/3] bg-slate-100 dark:bg-slate-900 rounded-lg overflow-hidden shadow-sm hover:scale-105 transition-all cursor-pointer dark:border dark:border-slate-800" onClick={() => setSelectedComic(comic)}>
                <img src={comic.image} alt={comic.name} loading="lazy" className="object-cover w-full h-full" />
                {status === 'LIBRARY' && (<div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 shadow-lg z-30"><CheckCircle2 className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                {status === 'REQUESTED' && (<div className="absolute top-2 right-2 bg-orange-500 text-white rounded-full p-1 shadow-lg z-30"><Clock className="w-4 h-4 sm:w-3 sm:h-3" /></div>)}
                
                {/* Title gradient always visible on mobile, hidden on desktop until hover */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3 pb-4 text-center gap-1 z-20 pointer-events-none">
                    <h3 className="text-white font-bold text-xs sm:text-sm line-clamp-2 leading-tight">{comic.name}</h3>
                    <p className="text-white/80 text-[10px] sm:text-xs">{comic.year}</p>
                </div>
            </div>
          )})}
        </div>
      )}

      <Dialog open={!!selectedComic} onOpenChange={(open) => !open && setSelectedComic(null)}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0 dark:bg-slate-950 dark:border-slate-800 rounded-xl w-[95%]">
            {selectedComic && (
                <>
                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                    <div className="mb-4 sm:mb-6">
                         <DialogTitle className="text-2xl sm:text-3xl font-bold leading-tight mb-2 dark:text-slate-100 pr-8">{selectedComic.name}</DialogTitle>
                         <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                           <Badge variant="outline" className="gap-1 font-normal dark:border-slate-800 dark:text-slate-400"><Calendar className="w-3 h-3"/> {selectedComic.year}</Badge>
                           {selectedComic.publisher && selectedComic.publisher !== 'Unknown' && (<span className="text-sm font-bold text-slate-500 dark:text-slate-400">{selectedComic.publisher}</span>)}
                         </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 sm:gap-8 mb-8">
                        <div className="space-y-4">
                            <div className="relative aspect-[2/3] w-[180px] sm:w-[200px] mx-auto md:w-full rounded-lg overflow-hidden border dark:border-slate-800 bg-slate-100 dark:bg-slate-900 shadow-md">
                                <img src={selectedComic.image} alt={selectedComic.name} className="absolute inset-0 w-full h-full object-contain" />
                            </div>
                            
                            {(() => {
                                const volStatus = getVolumeStatus(selectedComic.volumeId, selectedComic.name.split(' #')[0]);
                                const issueStatus = getIssueStatus(selectedComic.id, selectedComic.volumeId, selectedComic.name);
                                return (
                                  <div className="flex flex-col gap-2.5 sm:gap-3">
                                      <Button className="w-full gap-2 shadow-sm h-12 sm:h-10 text-sm font-bold" variant={volStatus ? "outline" : "default"} onClick={() => setMonitorPrompt({ id: selectedComic.volumeId, name: selectedComic.name.split(' #')[0], image: selectedComic.image, year: selectedComic.year, publisher: selectedComic.publisher || 'Unknown' })} disabled={requestingId === selectedComic.volumeId || volStatus !== null}>
                                          {volStatus === 'LIBRARY' ? (<><CheckCircle2 className="w-4 h-4 text-green-500" /> In Library</>) : volStatus === 'REQUESTED' ? (<><Clock className="w-4 h-4 text-orange-500" /> Requested</>) : requestingId === selectedComic.volumeId ? (<Loader2 className="w-4 h-4 animate-spin" />) : (<><Plus className="w-4 h-4" /> Request Series</>)}
                                      </Button>
                                      
                                      <Button className="w-full gap-2 shadow-sm h-12 sm:h-10 text-sm font-bold" variant={issueStatus ? "outline" : "secondary"} onClick={() => handleRequest(selectedComic.volumeId, selectedComic.name, selectedComic.image, selectedComic.year, 'issue', selectedComic.publisher)} disabled={requestingId === selectedComic.id || issueStatus !== null}>
                                          {issueStatus === 'LIBRARY' ? (<><CheckCircle2 className="w-4 h-4 text-green-500" /> In Library</>) : issueStatus === 'REQUESTED' ? (<><Clock className="w-4 h-4 text-orange-500" /> Requested</>) : requestingId === selectedComic.id ? (<Loader2 className="w-4 h-4 animate-spin" />) : (<><Download className="w-4 h-4" /> Request Issue</>)}
                                      </Button>
                                      
                                      <Button variant="outline" className="w-full gap-2 border-dashed shadow-sm h-12 sm:h-10 text-sm font-bold" onClick={() => setInteractiveQuery({ query: selectedComic.issueNumber ? selectedComic.name : selectedComic.name.split(' #')[0], type: selectedComic.issueNumber ? 'issue' : 'volume' })}>
                                          <SearchIcon className="w-4 h-4 text-blue-500" /> Interactive Search
                                      </Button>
                                  </div>
                                );
                            })()}

                        </div>
                        <div className="space-y-6">
                             {hasCreators && (
                                <div className="grid grid-cols-2 gap-4 bg-slate-50 dark:bg-slate-900 p-4 rounded-lg border dark:border-slate-800">
                                    {selectedComic.writers && selectedComic.writers.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Writer</p><p className="text-sm font-medium dark:text-slate-200">{selectedComic.writers.join(", ")}</p></div>)}
                                    {selectedComic.artists && selectedComic.artists.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Artist</p><p className="text-sm font-medium dark:text-slate-200">{selectedComic.artists.join(", ")}</p></div>)}
                                </div>
                             )}

                             {selectedComic.characters && selectedComic.characters.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm dark:text-slate-300"><Users className="w-4 h-4"/> Key Appearances</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedComic.characters.map((char: string) => (
                                            <Badge key={char} variant="secondary" className="font-medium text-[10px] bg-slate-100 dark:bg-slate-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700">{char}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             <div className="space-y-2">
                                <h4 className="font-semibold flex items-center gap-2 text-sm dark:text-slate-300"><Info className="w-4 h-4"/> Synopsis</h4>
                                <div className="text-sm text-muted-foreground leading-relaxed p-4 bg-slate-50 dark:bg-slate-900/50 rounded-md border dark:border-slate-800 min-h-[100px] break-words">
                                    {displayDescription || <span className="italic opacity-70">No synopsis available.</span>}
                                </div>
                             </div>
                        </div>
                    </div>
                    <div className="space-y-4 pt-4 border-t dark:border-slate-800">
                        <h4 className="font-semibold flex items-center gap-2 text-base sm:text-lg dark:text-slate-200"><Layers className="w-4 h-4 sm:w-5 sm:h-5"/> More in this Series</h4>
                        <div className="w-full">
                            {loadingRelated ? (<div className="flex gap-3 sm:gap-4 overflow-hidden">{[1,2,3,4,5].map(i => (<div key={i} className="w-[120px] aspect-[2/3] bg-slate-100 dark:bg-slate-900 animate-pulse rounded-md dark:border dark:border-slate-800" />))}</div>) : relatedIssues.length > 0 ? (
                                <ScrollArea className="w-full whitespace-nowrap pb-4">
                                    <div className="flex w-max gap-3 sm:gap-4 px-1">
                                        {relatedIssues.map(issue => {
                                            const relIssueStatus = getIssueStatus(issue.id, selectedComic.volumeId, issue.name);
                                            return (
                                            <div 
                                              key={issue.id} 
                                              className="w-[110px] sm:w-[130px] shrink-0 group/issue cursor-pointer relative"
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
                                            >
                                                <div className="relative aspect-[2/3] rounded-md overflow-hidden bg-slate-100 dark:bg-slate-900 border dark:border-slate-800 shadow-sm hover:ring-2 hover:ring-blue-500 transition-all">
                                                    <img src={issue.image} className="absolute inset-0 w-full h-full object-contain" alt={issue.name} />
                                                    
                                                    {/* Gradient overlay to ensure text is readable */}
                                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10 pointer-events-none" />
                                                    
                                                    {/* Issue Number Display */}
                                                    <div className="absolute bottom-1 left-2 z-20 text-white text-[11px] font-black truncate drop-shadow-md">#{issue.issueNumber}</div>
                                                    
                                                    {/* Permanent Download Icon on Mobile, Hover on Desktop */}
                                                    {!relIssueStatus && (
                                                        <div className="absolute bottom-1 right-1 z-30 opacity-100 sm:opacity-0 sm:group-hover/issue:opacity-100 transition-opacity">
                                                            <Button 
                                                                size="icon" 
                                                                className="h-8 w-8 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-lg" 
                                                                disabled={requestingId === issue.id} 
                                                                onClick={(e) => { 
                                                                    e.preventDefault(); 
                                                                    e.stopPropagation(); 
                                                                    handleRequest(selectedComic.volumeId, issue.name, issue.image, issue.year, 'issue', selectedComic.publisher); 
                                                                }}
                                                            >
                                                                {requestingId === issue.id ? <Loader2 className="w-4 h-4 animate-spin"/> : <Download className="w-4 h-4"/>}
                                                            </Button>
                                                        </div>
                                                    )}

                                                    {relIssueStatus === 'REQUESTED' && (<div className="absolute top-1 left-1 bg-orange-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20">REQUESTED</div>)}
                                                    {relIssueStatus === 'LIBRARY' && (<div className="absolute top-1 left-1 bg-green-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20">OWNED</div>)}
                                                </div>
                                            </div>
                                        )})}
                                    </div>
                                    <ScrollBar orientation="horizontal" className="h-1.5" />
                                </ScrollArea>
                            ) : (<p className="text-sm text-muted-foreground">No other issues found.</p>)}
                        </div>
                    </div>
                </div>
                <div className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-900 border-t dark:border-slate-800 flex flex-col sm:flex-row gap-2 sm:justify-between z-10 shrink-0">
                        {selectedComic.siteUrl && (<Button variant="secondary" asChild className="h-12 sm:h-10 sm:mr-auto bg-white shadow-sm font-bold dark:bg-slate-950 dark:hover:bg-slate-800 dark:text-slate-300 dark:border-slate-700"><Link href={selectedComic.siteUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4 mr-2" /> View on ComicVine</Link></Button>)}
                        <Button variant="outline" onClick={() => setSelectedComic(null)} className="h-12 sm:h-10 font-bold dark:border-slate-700 dark:hover:bg-slate-800">Close</Button>
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
        <DialogContent className="sm:max-w-md w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
          <DialogTitle className="text-xl font-bold">Monitor Series?</DialogTitle>
          <DialogDescription className="text-sm sm:text-base text-muted-foreground mt-2">
            You are requesting the series <strong>{monitorPrompt?.name}</strong>. Would you like Omnibus to automatically monitor this series and download new issues as they are released in the future?
          </DialogDescription>
          <div className="flex flex-col gap-3 mt-4 sm:mt-6">
            <Button className="w-full h-12 sm:h-10 bg-blue-600 hover:bg-blue-700 text-white font-bold" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, true);
                setMonitorPrompt(null);
            }}>
                Yes, Request & Monitor
            </Button>
            <Button variant="secondary" className="w-full h-12 sm:h-10 font-bold" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, false);
                setMonitorPrompt(null);
            }}>
                No, Just Request Current Issues
            </Button>
            <Button variant="ghost" className="w-full h-12 sm:h-10 font-bold text-slate-500" onClick={() => setMonitorPrompt(null)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}