"use client"

import { useState, useEffect, useMemo } from "react"
import { useSession } from "next-auth/react" 
import { Search, Loader2, X, Plus, Calendar, Info, Layers, ChevronLeft, Download, CheckCircle2, Clock, Globe, PenTool, Paintbrush, Users, Image as ImageIcon, Activity, Library, FileCheck, Tags, BookMarked, Shield, MapPin, ExternalLink } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader } from "@/components/ui/dialog"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Link from "next/link"
import { InteractiveSearchModal } from "./interactive-search-modal"

interface SearchResult {
  id: number;
  name: string;
  year: string;
  publisher: string;
  image: string;
  description: string;
  count: number;
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
}

interface Issue {
  id: number;
  name: string;
  issueNumber: string;
  year: string;
  image: string;
  description?: string; 
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
}

type StatusType = 'LIBRARY_MONITORED' | 'LIBRARY_UNMONITORED' | 'ISSUE_OWNED' | 'REQUESTED' | 'PENDING_APPROVAL' | null;

export function RequestSearch() {
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const [homeQuery, setHomeQuery] = useState("")
  const [searchSort, setSearchSort] = useState("relevance")
  const [interactiveQuery, setInteractiveQuery] = useState<{ query: string, type: 'volume' | 'issue' } | null>(null)
  
  const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string } | null>(null);
  
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  
  // Pagination State
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreSearch, setHasMoreSearch] = useState(false);
  const [isSearchingMore, setIsSearchingMore] = useState(false);

  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [volumeIssues, setVolumeIssues] = useState<Issue[]>([])
  
  const [requestingTarget, setRequestingTarget] = useState<string | null>(null)
  const [requestedVolumes, setRequestedVolumes] = useState<Set<number>>(new Set())
  const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set())
  
  const [ownedSeries, setOwnedSeries] = useState<Set<number>>(new Set())
  const [monitoredSeries, setMonitoredSeries] = useState<Set<number>>(new Set())
  const [ownedIssues, setOwnedIssues] = useState<Set<number>>(new Set())
  const [activeRequests, setActiveRequests] = useState<any[]>([])

  const { toast } = useToast()

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
  }, [open]);

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

  const performSearch = async (e?: React.FormEvent, isLoadMore = false) => {
    if (e) e.preventDefault();
    if (homeQuery.trim().length < 2) return;

    const nextPage = isLoadMore ? searchPage + 1 : 1;

    if (!isLoadMore) {
        setOpen(true); 
        setLoading(true); 
        setSelectedItem(null);
    } else {
        setIsSearchingMore(true);
    }

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(homeQuery)}&page=${nextPage}&_t=${Date.now()}`)
      const data = await res.json()
      
      if (isLoadMore) {
          setResults(prev => [...prev, ...(data.results || [])]);
      } else {
          setResults(data.results || []);
      }
      
      setHasMoreSearch(data.hasMore || false);
      setSearchPage(nextPage);
    } catch (e) {
      toast({ title: "Search failed", variant: "destructive" });
    } finally { 
      setLoading(false);
      setIsSearchingMore(false);
    }
  }

  const sortedResults = useMemo(() => {
      let sorted = [...results];
      if (searchSort === 'year_desc') sorted.sort((a, b) => parseInt(b.year || '0') - parseInt(a.year || '0'));
      if (searchSort === 'year_asc') sorted.sort((a, b) => parseInt(a.year || '0') - parseInt(b.year || '0'));
      if (searchSort === 'name_asc') sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      if (searchSort === 'name_desc') sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
      if (searchSort === 'issues_desc') sorted.sort((a, b) => (b.count || 0) - (a.count || 0));
      return sorted;
  }, [results, searchSort]);

  const handleSelectSearchResult = async (item: SearchResult) => {
      setLoading(true);
      try {
          const res = await fetch(`/api/series-issues?volumeId=${item.id}&_t=${Date.now()}`);
          const data = await res.json();
          const issues = data.results || [];
          
          const sortedDesc = [...issues].sort((a: Issue, b: Issue) => (parseFloat(b.issueNumber) || 0) - (parseFloat(a.issueNumber) || 0));
          setVolumeIssues(sortedDesc);
          
          const firstIssue = [...issues].sort((a: Issue, b: Issue) => (parseFloat(a.issueNumber) || 0) - (parseFloat(b.issueNumber) || 0))[0];
          
          if (firstIssue) {
              setSelectedItem({
                  ...firstIssue,
                  volumeId: item.id,
                  publisher: item.publisher,
                  isVolume: false 
              });
          } else {
              setSelectedItem({ ...item, volumeId: item.id, isVolume: true });
          }
      } catch (e) {
          setVolumeIssues([]);
          setSelectedItem({ ...item, volumeId: item.id, isVolume: true });
      } finally {
          setLoading(false);
      }
  }

  useEffect(() => {
    if (!selectedItem?.id) return;
    const itemType = selectedItem.isVolume ? 'volume' : 'issue';
    
    fetch(`/api/issue-details?id=${selectedItem.id}&type=${itemType}&volId=${selectedItem.volumeId || ''}&_t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        if (data && !data.error) {
          setSelectedItem((prev: any) => {
            if (prev?.id !== data.id) return prev; 
            return {
                ...prev,
                ...data,
                name: data.name || prev?.name,
                publisher: (data.publisher && data.publisher !== 'Unknown') ? data.publisher : prev?.publisher,
                year: (data.year && data.year !== '????') ? data.year : prev?.year,
                image: data.image || prev?.image,
                description: data.description?.trim() ? data.description : prev?.description
            };
          });
        }
      });
  }, [selectedItem?.id, selectedItem?.isVolume]);

  const handleRequest = async (id: number, name: string, image: string, year: string, type: 'volume' | 'issue', publisher: string, monitored: boolean = false, issueNumber?: string) => {
    if (!name || name === "Unknown" || name === "undefined") {
        toast({ title: "Request Failed", description: "Missing valid series name. Try interactive search.", variant: "destructive" });
        return;
    }

    const exactIssueName = (type === 'issue' && issueNumber && !name.includes(`#${issueNumber}`)) ? `${name} #${issueNumber}` : name;
    const targetKey = type === 'volume' ? `vol-${id}` : `iss-${exactIssueName}`;
    
    setRequestingTarget(targetKey);
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            cvId: id, 
            name: exactIssueName, 
            year, 
            publisher: publisher || "Unknown", 
            image, 
            type, 
            monitored,
            issueNumber: issueNumber || (type === 'issue' ? "1" : undefined)
        })
      });

      if (res.ok) {
        toast({ title: "Success", description: `${exactIssueName} added to queue.` })
        if (type === 'volume') {
            setRequestedVolumes(prev => new Set(prev).add(id));
            setOpen(false);
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

  const getDisplayDescription = () => {
    if (selectedItem?.description?.trim() && selectedItem.description !== "No description available.") {
        return selectedItem.description;
    }
    if (volumeIssues && volumeIssues.length > 0) {
      const sortedCv = [...volumeIssues].sort((a, b) => {
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
  const hasCreators = selectedItem && (
    (selectedItem.writers?.length ?? 0) > 0 || 
    (selectedItem.artists?.length ?? 0) > 0 ||
    (selectedItem.coverArtists?.length ?? 0) > 0 ||
    (selectedItem.colorists?.length ?? 0) > 0 ||
    (selectedItem.letterers?.length ?? 0) > 0
  );
  
  const seriesBaseName = selectedItem?.volumeName || (selectedItem?.name ? selectedItem.name.split(' #')[0] : "Unknown");

  return (
    <div className="w-full max-w-2xl mx-auto transition-colors duration-300">
      <form 
        onSubmit={performSearch} 
        className="flex items-center gap-2 p-1 bg-background rounded-xl shadow-lg border border-border transition-colors duration-300"
      >
        <div className="relative flex-1 h-12">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input 
            placeholder="Search for a comic series..." 
            className="pl-11 h-full border-none bg-transparent focus-visible:ring-0 text-lg text-foreground placeholder:text-muted-foreground" 
            value={homeQuery} 
            onChange={(e) => setHomeQuery(e.target.value)} 
          />
        </div>
        <Button type="submit" className="h-12 px-8 rounded-lg font-bold">Search</Button>
      </form>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl [&>button]:hidden bg-background">
          <div className="p-4 border-b border-border bg-muted/30 flex flex-col sm:flex-row items-start sm:items-center justify-between z-10 transition-colors duration-300 gap-4">
            <div className="flex items-center gap-2">
              {selectedItem && (<Button variant="ghost" size="sm" onClick={() => setSelectedItem(null)} className="mr-2 -ml-2 text-foreground"><ChevronLeft className="w-4 h-4 mr-1" /> Back</Button>)}
              <DialogTitle className="text-xl font-bold truncate max-w-md text-foreground">{selectedItem ? selectedItem.name : `Results for "${homeQuery}"`}</DialogTitle>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            </div>
            {!selectedItem && sortedResults.length > 0 && (
                <div className="flex items-center gap-2">
                    <Select value={searchSort} onValueChange={setSearchSort}>
                        <SelectTrigger className="w-[150px] shrink-0 h-9 bg-background"><SelectValue placeholder="Sort By" /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="relevance">Relevance</SelectItem>
                            <SelectItem value="year_desc">Newest Year</SelectItem>
                            <SelectItem value="year_asc">Oldest Year</SelectItem>
                            <SelectItem value="name_asc">Name (A-Z)</SelectItem>
                            <SelectItem value="name_desc">Name (Z-A)</SelectItem>
                            <SelectItem value="issues_desc">Most Issues</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" className="text-foreground" onClick={() => setOpen(false)}><X className="h-5 w-5" /></Button>
                </div>
            )}
            {selectedItem && <Button variant="ghost" size="icon" className="text-foreground hidden sm:flex" onClick={() => setOpen(false)}><X className="h-5 w-5" /></Button>}
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-background transition-colors duration-300">
            {!selectedItem ? (
                <>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 pb-4 px-1">
                  {sortedResults.map((item) => {
                    const volStatus = getVolumeStatus(item.id, item.name);
                    return (
                    <div key={item.id} className="cursor-pointer space-y-2 group flex flex-col" onClick={() => handleSelectSearchResult(item)}>
                      <div className="relative aspect-[2/3] w-full rounded-lg overflow-hidden border bg-muted shadow-md border-border transition-colors duration-300">
                        <img src={item.image} alt={item.name} className="absolute inset-0 w-full h-full object-contain transition-transform duration-300 group-hover:scale-105" />
                        
                        {volStatus === 'LIBRARY_MONITORED' && (<div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 z-10 shadow-md" title="Monitored"><Activity className="w-4 h-4" /></div>)}
                        {volStatus === 'LIBRARY_UNMONITORED' && (<div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-1 z-10 shadow-md" title="In Library"><Library className="w-4 h-4" /></div>)}
                        {volStatus === 'ISSUE_OWNED' && (<div className="absolute top-2 right-2 bg-emerald-500 text-white rounded-full p-1 z-10 shadow-md" title="In Library"><FileCheck className="w-4 h-4" /></div>)}

                        {volStatus === 'REQUESTED' && (<div className="absolute top-2 right-2 bg-orange-500 text-white rounded-full p-1 z-10 shadow-md" title="Requested"><Clock className="w-4 h-4" /></div>)}
                        {volStatus === 'PENDING_APPROVAL' && (<div className="absolute top-2 right-2 bg-yellow-500 text-white rounded-full p-1 z-10 shadow-md" title="Pending Admin Approval"><Clock className="w-4 h-4" /></div>)}
                        
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-20">
                          <Button size="sm" className="font-bold shadow-lg bg-primary hover:bg-primary/90 text-primary-foreground">Details</Button>
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-center text-center px-1">
                          <h4 className="text-xs font-black line-clamp-1 text-foreground" title={item.name}>{item.name}</h4>
                          <span className="text-[10px] font-bold text-muted-foreground line-clamp-1" title={item.publisher}>{item.publisher || "Unknown"}</span>
                          <span className="text-[9px] font-bold text-muted-foreground/80 uppercase tracking-wider mt-0.5">
                              {item.year || "????"} • {item.count || 0} Issues
                          </span>
                      </div>
                    </div>
                  )})}
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
                </>
            ) : (
              <div className="h-full flex flex-col">
                  <div className="mb-6">
                    <h2 className="text-3xl font-bold leading-tight mb-2 text-foreground">{selectedItem.name}</h2>
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="outline" className="gap-1 font-normal border-border text-muted-foreground"><Calendar className="w-3 h-3"/> {selectedItem.year}</Badge>
                      {selectedItem.publisher && selectedItem.publisher !== 'Unknown' && (
                          <span className="text-sm font-bold text-muted-foreground">{selectedItem.publisher}</span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-8 mb-8">
                      <div className="space-y-5 flex flex-col items-center md:items-stretch">
                          <div className="relative aspect-[2/3] w-[200px] md:w-[240px] mx-auto rounded-lg overflow-hidden border bg-muted shadow-md border-border transition-colors duration-300">
                              <img src={selectedItem.image} alt={selectedItem.name} className="absolute inset-0 w-full h-full object-contain" />
                          </div>
                          
                          {(() => {
                              const issueTargetName = selectedItem.isVolume ? `${seriesBaseName} #${selectedItem.issueNumber || "1"}` : selectedItem.name;
    
                              const volStatus = getVolumeStatus(selectedItem.volumeId, seriesBaseName);
                              const issueStatus = getIssueStatus(selectedItem.id, selectedItem.volumeId, issueTargetName);
                              
                              const isVolOwned = volStatus === 'LIBRARY_MONITORED' || volStatus === 'LIBRARY_UNMONITORED';
                              const isIssueOwned = issueStatus === 'ISSUE_OWNED';
                              const overallStatus = selectedItem.isVolume ? volStatus : issueStatus;

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
                                            onClick={() => setMonitorPrompt({ id: selectedItem.volumeId, name: seriesBaseName, image: selectedItem.image, year: selectedItem.year, publisher: selectedItem.publisher || 'Unknown' })} 
                                            disabled={requestingTarget === `vol-${selectedItem.volumeId}`}
                                        >
                                            {requestingTarget === `vol-${selectedItem.volumeId}` ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : (
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
                                            onClick={() => handleRequest(selectedItem.volumeId, selectedItem.isVolume ? seriesBaseName : selectedItem.name, selectedItem.image, selectedItem.year, 'issue', selectedItem.publisher, false, selectedItem.issueNumber || "1")} 
                                            disabled={requestingTarget === `iss-${issueTargetName}`}
                                        >
                                            {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <><Download className="w-4 h-4 shrink-0" /> <span className="leading-tight text-center">Request Issue</span></>}
                                        </Button>
                                    )}
                                    
                                    <Button 
                                      variant="outline" 
                                      className="w-full gap-1.5 border-dashed shadow-sm h-auto min-h-[2.5rem] py-1.5 text-sm font-bold border-border hover:bg-muted text-foreground whitespace-normal" 
                                      onClick={() => setInteractiveQuery({ query: selectedItem.isVolume ? seriesBaseName : selectedItem.name, type: selectedItem.isVolume ? 'issue' : 'volume' })}
                                      disabled={(!selectedItem.isVolume && isIssueOwned) || overallStatus === 'PENDING_APPROVAL' || overallStatus === 'REQUESTED'}
                                    >
                                        {overallStatus === 'PENDING_APPROVAL' ? (
                                            <><Clock className="w-4 h-4 text-yellow-500 shrink-0" /> <span className="leading-tight">Pending Approval</span></>
                                        ) : overallStatus === 'REQUESTED' ? (
                                            <><Clock className="w-4 h-4 text-orange-500 shrink-0" /> <span className="leading-tight">Requested</span></>
                                        ) : (!selectedItem.isVolume && isIssueOwned) ? (
                                            <><FileCheck className="w-4 h-4 text-emerald-500 shrink-0" /> <span className="leading-tight">In Library</span></>
                                        ) : (
                                            <><Search className="w-4 h-4 text-primary shrink-0" /> <span className="leading-tight">Interactive Search</span></>
                                        )}
                                    </Button>
                                </div>
                              );
                          })()}

                      </div>
                      <div className="space-y-6">
                             {hasCreators && (
                                <div className="grid grid-cols-2 gap-4 bg-muted/50 p-4 rounded-lg border border-border transition-colors duration-300">
                                    {selectedItem.writers?.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Writer</p><p className="text-sm font-medium text-foreground">{selectedItem.writers.join(", ")}</p></div>)}
                                    {selectedItem.artists?.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Artist</p><p className="text-sm font-medium text-foreground">{selectedItem.artists.join(", ")}</p></div>)}
                                    {selectedItem.coverArtists?.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><ImageIcon className="w-3 h-3" /> Cover Artist</p><p className="text-sm font-medium text-foreground">{selectedItem.coverArtists.join(", ")}</p></div>)}
                                    {selectedItem.colorists?.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Colorist</p><p className="text-sm font-medium text-foreground">{selectedItem.colorists.join(", ")}</p></div>)}
                                    {selectedItem.letterers?.length > 0 && (<div><p className="text-[10px] sm:text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Letterer</p><p className="text-sm font-medium text-foreground">{selectedItem.letterers.join(", ")}</p></div>)}
                                </div>
                             )}

                             {selectedItem.characters && selectedItem.characters.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Users className="w-4 h-4"/> Characters</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedItem.characters.map((char: string) => (
                                            <Badge key={char} variant="secondary" className="font-medium text-[10px] bg-muted text-foreground border-border hover:bg-muted/80">{char}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             {selectedItem.teams && selectedItem.teams.length > 0 && (
                                <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Shield className="w-4 h-4 text-primary"/> Teams</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedItem.teams.map((team: string) => (
                                            <Badge key={team} variant="secondary" className="font-medium text-[10px] bg-primary/5 text-primary border-primary/20 hover:bg-primary/10">{team}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             {selectedItem.locations && selectedItem.locations.length > 0 && (
                                <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><MapPin className="w-4 h-4 text-primary"/> Locations</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedItem.locations.map((loc: string) => (
                                            <Badge key={loc} variant="outline" className="font-medium text-[10px] bg-background text-muted-foreground border-border">{loc}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                             {selectedItem.genres && selectedItem.genres.length > 0 && (
                                 <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                     <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Tags className="w-4 h-4 text-primary"/> Concepts</h4>
                                     <div className="flex flex-wrap gap-1.5">
                                         {selectedItem.genres.map((genre: string) => (
                                             <Badge key={genre} variant="outline" className="font-medium text-[10px] bg-background text-muted-foreground border-border hover:text-foreground">{genre}</Badge>
                                         ))}
                                     </div>
                                 </div>
                             )}

                             {selectedItem.storyArcs && selectedItem.storyArcs.length > 0 && (
                                 <div className="space-y-2 mt-4 pt-4 border-t border-border">
                                     <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><BookMarked className="w-4 h-4 text-primary"/> Story Arcs</h4>
                                     <div className="flex flex-wrap gap-1.5">
                                         {selectedItem.storyArcs.map((arc: string) => (
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
                          {volumeIssues.length > 0 ? (
                              <ScrollArea className="w-full whitespace-nowrap pb-4">
                                  <div className="flex w-max gap-4 px-1">
                                      {volumeIssues.map(issue => {
                                          const relIssueTargetName = issue.name;
                                          const relIssueStatus = getIssueStatus(issue.id, selectedItem.volumeId, relIssueTargetName);
                                          
                                          return (
                                          <div 
                                              key={issue.id} 
                                              className="w-[110px] sm:w-[130px] shrink-0 group/issue cursor-pointer relative"
                                              onClick={() => {
                                                  setSelectedItem({
                                                      ...issue,
                                                      volumeId: selectedItem.volumeId,
                                                      publisher: selectedItem.publisher,
                                                      issueNumber: issue.issueNumber,
                                                      description: undefined,
                                                      writers: undefined,
                                                      artists: undefined,
                                                      characters: undefined
                                                  });
                                              }}
                                            >
                                              <div className="relative aspect-[2/3] rounded-md overflow-hidden bg-muted border border-border shadow-sm hover:ring-2 hover:ring-primary transition-all">
                                                  <img src={issue.image} className="absolute inset-0 w-full h-full object-contain" alt={issue.name} />
                                                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10 pointer-events-none" />
                                                  
                                                  <div className="absolute top-1 right-1 bg-black/80 text-white rounded-md px-1.5 py-0.5 text-[10px] font-bold z-20 shadow-sm border border-white/20">#{issue.issueNumber}</div>

                                                  {!relIssueStatus && (
                                                      <div className="absolute bottom-2 inset-x-2 z-30 opacity-100 sm:opacity-0 sm:group-hover/issue:opacity-100 transition-opacity flex justify-center items-center pointer-events-none">
                                                          <Button
                                                              size="icon"
                                                              className="h-8 w-8 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg pointer-events-auto"
                                                              disabled={requestingTarget === `iss-${relIssueTargetName}`}
                                                              onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                handleRequest(selectedItem.volumeId, issue.name, issue.image, issue.year, 'issue', selectedItem.publisher, false, issue.issueNumber);
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
                                  <ScrollBar orientation="horizontal" />
                              </ScrollArea>
                          ) : (<p className="text-sm text-muted-foreground">No individual issues found.</p>)}
                      </div>
                  </div>
              </div>
            )}
          </div>
          {selectedItem && (
            <div className="p-4 bg-background border-t border-border flex justify-between shrink-0 z-10 transition-colors duration-300">
                <Button variant="secondary" asChild><Link href={selectedItem.siteUrl || `https://comicvine.gamespot.com/volume/4050-${selectedItem.volumeId}/`} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-4 h-4 mr-2" /> View Details</Link></Button>
                <Button variant="outline" className="text-foreground" onClick={() => setOpen(false)}>Close</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {selectedItem && interactiveQuery && (
        <InteractiveSearchModal 
          isOpen={!!interactiveQuery} 
          onClose={() => setInteractiveQuery(null)} 
          initialQuery={interactiveQuery.query}
          comicData={{
            cvId: selectedItem.volumeId,
            year: selectedItem.year,
            publisher: selectedItem.publisher || 'Unknown',
            image: selectedItem.image,
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
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, true);
                setMonitorPrompt(null);
            }}>
                Yes, Request & Monitor
            </Button>
            <Button variant="outline" className="w-full h-12 sm:h-10 font-bold border-primary/30 text-primary bg-primary/10 hover:bg-primary/20" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, false);
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