"use client"

import { useState, useEffect } from "react"
import { Search, Loader2, X, Plus, Calendar, Info, Layers, ChevronLeft, Download, CheckCircle2, Clock, ExternalLink, PenTool, Paintbrush, Image as ImageIcon, Users } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
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
  characters?: string[];
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
  characters?: string[];
}

type StatusType = 'LIBRARY' | 'REQUESTED' | null;

export function RequestSearch() {
  const [open, setOpen] = useState(false)
  const [homeQuery, setHomeQuery] = useState("")
  const [interactiveQuery, setInteractiveQuery] = useState<{ query: string, type: 'volume' | 'issue' } | null>(null)
  const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string } | null>(null);
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [volumeIssues, setVolumeIssues] = useState<Issue[]>([])
  const [requestingId, setRequestingId] = useState<number | null>(null)
  
  const [ownedSeries, setOwnedSeries] = useState<Set<number>>(new Set())
  const [ownedIssues, setOwnedIssues] = useState<Set<number>>(new Set())
  const [activeRequests, setActiveRequests] = useState<any[]>([])

  const { toast } = useToast()

  useEffect(() => {
    fetch('/api/library/ids') 
      .then(res => res.json())
      .then(data => { 
          if (data) {
              setOwnedSeries(new Set(data.series || []));
              setOwnedIssues(new Set(data.issues || []));
              setActiveRequests(data.requests || []);
          }
      })
      .catch(() => {});
  }, [open]);

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

  const performSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (homeQuery.trim().length < 2) return;
    setOpen(true); setLoading(true); setSelectedItem(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(homeQuery)}&_t=${Date.now()}`)
      const data = await res.json()
      if (data.results) setResults(data.results)
    } finally { setLoading(false) }
  }

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
        if (type === 'volume') setOpen(false)
      }
    } finally { setRequestingId(null) }
  }

  const hasCreators = selectedItem && ((selectedItem.writers?.length ?? 0) > 0 || (selectedItem.artists?.length ?? 0) > 0);

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

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form 
        onSubmit={performSearch} 
        className="flex items-center gap-2 p-1 bg-white dark:bg-slate-900 rounded-xl shadow-lg border border-slate-200 dark:border-slate-800"
      >
        <div className="relative flex-1 h-12">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input 
            placeholder="Search for a comic series..." 
            className="pl-11 h-full border-none bg-transparent focus-visible:ring-0 text-lg dark:text-slate-100 dark:placeholder:text-slate-500" 
            value={homeQuery} 
            onChange={(e) => setHomeQuery(e.target.value)} 
          />
        </div>
        <Button type="submit" className="h-12 px-8 rounded-lg font-bold">Search</Button>
      </form>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0 border-none shadow-2xl [&>button]:hidden dark:bg-slate-950">
          <div className="p-4 border-b bg-white dark:bg-slate-900 flex items-center justify-between z-10">
            <div className="flex items-center gap-2">
              {selectedItem && (<Button variant="ghost" size="sm" onClick={() => setSelectedItem(null)} className="mr-2 -ml-2"><ChevronLeft className="w-4 h-4 mr-1" /> Back</Button>)}
              <DialogTitle className="text-xl font-bold truncate max-w-md">{selectedItem ? selectedItem.name : `Results for "${homeQuery}"`}</DialogTitle>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
            </div>
            <Button variant="ghost" size="icon" onClick={() => setOpen(false)}><X className="h-5 w-5" /></Button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-slate-50 dark:bg-slate-950">
            {!selectedItem ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 pb-4 px-1">
                  {results.map((item) => {
                    const volStatus = getVolumeStatus(item.id, item.name);
                    return (
                    <div key={item.id} className="cursor-pointer space-y-2 group flex flex-col" onClick={() => handleSelectSearchResult(item)}>
                      <div className="relative aspect-[2/3] w-full rounded-lg overflow-hidden border bg-slate-100 dark:bg-slate-900 shadow-md dark:border-slate-800">
                        <img src={item.image} alt={item.name} className="absolute inset-0 w-full h-full object-contain transition-transform duration-300 group-hover:scale-105" />
                        {volStatus === 'LIBRARY' && (<div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 z-10 shadow-md"><CheckCircle2 className="w-4 h-4" /></div>)}
                        {volStatus === 'REQUESTED' && (<div className="absolute top-2 right-2 bg-orange-500 text-white rounded-full p-1 z-10 shadow-md"><Clock className="w-4 h-4" /></div>)}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-20">
                          <Button size="sm" className="font-bold shadow-lg">Details</Button>
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
                  )})}
                </div>
            ) : (
              <div className="h-full flex flex-col">
                  <div className="mb-6">
                    <h2 className="text-3xl font-bold leading-tight mb-2 dark:text-slate-100">{selectedItem.name}</h2>
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="outline" className="gap-1 font-normal dark:border-slate-800 dark:text-slate-400"><Calendar className="w-3 h-3"/> {selectedItem.year}</Badge>
                      {selectedItem.publisher && selectedItem.publisher !== 'Unknown' && (
                          <span className="text-sm font-bold text-slate-500 dark:text-slate-400">{selectedItem.publisher}</span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-8 mb-8">
                      <div className="space-y-4">
                          <div className="relative aspect-[2/3] w-[200px] mx-auto md:w-full rounded-lg overflow-hidden border bg-slate-100 dark:bg-slate-900 shadow-md dark:border-slate-800">
                              <img src={selectedItem.image} alt={selectedItem.name} className="absolute inset-0 w-full h-full object-contain" />
                          </div>
                          
                          {(() => {
                              const volStatus = getVolumeStatus(selectedItem.volumeId, selectedItem.name.split(' #')[0]);
                              const issueStatus = getIssueStatus(selectedItem.id, selectedItem.volumeId, selectedItem.name);
                              return (
                                <div className="flex flex-col gap-3">
                                    <Button className="w-full gap-2 shadow-sm" variant={volStatus ? "outline" : "default"} onClick={() => setMonitorPrompt({ id: selectedItem.volumeId, name: selectedItem.name.split(' #')[0], image: selectedItem.image, year: selectedItem.year, publisher: selectedItem.publisher || 'Unknown' })} disabled={requestingId === selectedItem.volumeId || volStatus !== null}>
                                        {volStatus === 'LIBRARY' ? (<><CheckCircle2 className="w-4 h-4 text-green-500" /> In Library</>) : volStatus === 'REQUESTED' ? (<><Clock className="w-4 h-4 text-orange-500" /> Requested</>) : requestingId === selectedItem.volumeId ? (<Loader2 className="w-4 h-4 animate-spin" />) : (<><Plus className="w-4 h-4" /> Request Series</>)}
                                    </Button>
                                    
                                    <Button className="w-full gap-2 shadow-sm" variant={issueStatus ? "outline" : "secondary"} onClick={() => handleRequest(selectedItem.volumeId, selectedItem.isVolume ? `${selectedItem.name.split(' #')[0]} #1` : selectedItem.name, selectedItem.image, selectedItem.year, 'issue', selectedItem.publisher)} disabled={requestingId === selectedItem.id || issueStatus !== null}>
                                        {issueStatus === 'LIBRARY' ? (<><CheckCircle2 className="w-4 h-4 text-green-500" /> In Library</>) : issueStatus === 'REQUESTED' ? (<><Clock className="w-4 h-4 text-orange-500" /> Requested</>) : requestingId === selectedItem.id ? (<Loader2 className="w-4 h-4 animate-spin" />) : (<><Download className="w-4 h-4" /> Request Issue</>)}
                                    </Button>
                                    
                                    <Button variant="outline" className="w-full gap-2 border-dashed shadow-sm" onClick={() => setInteractiveQuery({ query: selectedItem.isVolume ? selectedItem.name.split(' #')[0] : selectedItem.name, type: selectedItem.isVolume ? 'volume' : 'issue' })}>
                                        <Search className="w-4 h-4 text-blue-500" /> Interactive Search
                                    </Button>
                                </div>
                              );
                          })()}

                      </div>
                      <div className="space-y-6">
                            {hasCreators && (
                                <div className="grid grid-cols-2 gap-4 bg-white dark:bg-slate-900 p-4 rounded-lg border dark:border-slate-800">
                                    {selectedItem.writers?.length > 0 && (<div><p className="text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Writer</p><p className="text-sm font-medium">{selectedItem.writers.join(", ")}</p></div>)}
                                    {selectedItem.artists?.length > 0 && (<div><p className="text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Artist</p><p className="text-sm font-medium">{selectedItem.artists.join(", ")}</p></div>)}
                                </div>
                             )}

                            {selectedItem.characters && selectedItem.characters.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm"><Users className="w-4 h-4"/> Key Appearances</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedItem.characters.map((char: string) => (
                                            <Badge key={char} variant="secondary" className="font-medium text-[10px] bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">{char}</Badge>
                                        ))}
                                    </div>
                                </div>
                             )}

                            <div className="space-y-2">
                              <h4 className="font-semibold flex items-center gap-2 text-sm"><Info className="w-4 h-4"/> Synopsis</h4>
                              <div className="text-sm text-muted-foreground leading-relaxed p-4 bg-white dark:bg-slate-900 rounded-md border dark:border-slate-800 min-h-[100px] break-words">
                                  {displayDescription || <span className="italic opacity-70">No synopsis available.</span>}
                              </div>
                            </div>
                      </div>
                  </div>
                  <div className="space-y-4 pt-4 border-t dark:border-slate-800">
                      <h4 className="font-semibold flex items-center gap-2 text-lg"><Layers className="w-5 h-5"/> More in this Series</h4>
                      <div className="w-full">
                          {volumeIssues.length > 0 ? (
                              <ScrollArea className="w-full whitespace-nowrap pb-4">
                                  <div className="flex w-max gap-4 px-1">
                                      {volumeIssues.map(issue => {
                                          const relIssueStatus = getIssueStatus(issue.id, selectedItem.volumeId, issue.name);
                                          return (
                                          <div key={issue.id} className="w-[120px] shrink-0 group/issue">
                                              <div className="relative aspect-[2/3] rounded-md overflow-hidden bg-slate-100 dark:bg-slate-900 border dark:border-slate-800 shadow-sm">
                                                  <img src={issue.image} className="absolute inset-0 w-full h-full object-contain" alt={issue.name} />
                                                  <div className="absolute inset-0 bg-black/70 opacity-0 group-hover/issue:opacity-100 transition-opacity flex flex-col items-center justify-center p-2 gap-2 z-20">
                                                      {!relIssueStatus && (<Button size="sm" variant="default" className="w-full h-7 text-[10px] font-bold bg-blue-600 text-white" disabled={requestingId === issue.id} onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRequest(selectedItem.volumeId, issue.name, issue.image, issue.year, 'issue'); }}>{requestingId === issue.id ? <Loader2 className="w-3 h-3 animate-spin"/> : "Get"}</Button>)}
                                                      <Button size="sm" variant="secondary" className="w-full h-7 text-[10px] font-bold" onClick={(e) => { 
                                                          e.preventDefault(); 
                                                          e.stopPropagation(); 
                                                          setSelectedItem({
                                                              ...issue, 
                                                              volumeId: selectedItem.volumeId, 
                                                              publisher: selectedItem.publisher, 
                                                              isVolume: false,
                                                              description: undefined,
                                                              writers: undefined,
                                                              artists: undefined,
                                                              characters: undefined
                                                          }); 
                                                      }}>Info</Button>
                                                  </div>
                                                  <div className="absolute bottom-0 inset-x-0 bg-black/80 text-white text-[10px] font-bold py-1 px-2">#{issue.issueNumber}</div>
                                                  {relIssueStatus === 'REQUESTED' && (<div className="absolute top-1 left-1 bg-orange-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold">REQUESTED</div>)}
                                                  {relIssueStatus === 'LIBRARY' && (<div className="absolute top-1 left-1 bg-green-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold">OWNED</div>)}
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
            <div className="p-4 bg-white dark:bg-slate-900 border-t dark:border-slate-800 flex justify-between shrink-0 z-10">
                <Button variant="secondary" asChild><Link href={selectedItem.siteUrl || `https://comicvine.gamespot.com/volume/4050-${selectedItem.volumeId}/`} target="_blank" rel="noopener noreferrer">ComicVine</Link></Button>
                <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
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
        <DialogContent className="sm:max-w-md dark:bg-slate-950 dark:border-slate-800">
          <DialogTitle className="text-xl font-bold">Monitor Series?</DialogTitle>
          <DialogDescription className="text-base text-muted-foreground mt-2">
            You are requesting the series <strong>{monitorPrompt?.name}</strong>. Would you like Omnibus to automatically monitor this series and download new issues as they are released in the future?
          </DialogDescription>
          <div className="flex flex-col gap-3 mt-6">
            <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, true);
                setMonitorPrompt(null);
            }}>
                Yes, Request & Monitor
            </Button>
            <Button variant="secondary" className="w-full font-bold" onClick={() => {
                if (monitorPrompt) handleRequest(monitorPrompt.id, monitorPrompt.name, monitorPrompt.image, monitorPrompt.year, 'volume', monitorPrompt.publisher, false);
                setMonitorPrompt(null);
            }}>
                No, Just Request Current Issues
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setMonitorPrompt(null)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}