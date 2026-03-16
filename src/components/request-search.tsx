"use client"

import { useState, useEffect } from "react"
import { Search, Loader2, X, Plus, Calendar, Info, Layers, ChevronLeft, Download, CheckCircle2, Clock, Globe, PenTool, Paintbrush, Users, Image as ImageIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader } from "@/components/ui/dialog"
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

type StatusType = 'LIBRARY' | 'REQUESTED' | 'PENDING_APPROVAL' | null;

export function RequestSearch() {
  const [open, setOpen] = useState(false)
  const [homeQuery, setHomeQuery] = useState("")
  const [interactiveQuery, setInteractiveQuery] = useState<{ query: string, type: 'volume' | 'issue' } | null>(null)
  
  const [monitorPrompt, setMonitorPrompt] = useState<{ id: number, name: string, image: string, year: string, publisher: string, directSource?: 'getcomics' } | null>(null);
  
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [volumeIssues, setVolumeIssues] = useState<Issue[]>([])
  
  const [requestingTarget, setRequestingTarget] = useState<string | null>(null)
  const [requestedVolumes, setRequestedVolumes] = useState<Set<number>>(new Set())
  const [requestedIssues, setRequestedIssues] = useState<Set<string>>(new Set())
  
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
      if (requestedVolumes.has(volumeId)) return 'REQUESTED';
      
      const activeReqs = activeRequests.filter(r => r.volumeId === volumeId);
      if (activeReqs.length > 0) {
          const allCompleted = activeReqs.every(r => ['IMPORTED', 'COMPLETED'].includes(r.status));
          if (allCompleted) return 'LIBRARY';
          if (activeReqs.some(r => r.status === 'PENDING_APPROVAL')) return 'PENDING_APPROVAL';
      }
      return null;
  }

  const getIssueStatus = (issueId: number, volumeId: number, issueName: string): StatusType => {
      if (ownedIssues.has(issueId)) return 'LIBRARY';
      if (requestedIssues.has(issueName)) return 'REQUESTED';

      const req = activeRequests.find(r => r.volumeId === volumeId && r.name === issueName);
      if (req) {
          if (['IMPORTED', 'COMPLETED'].includes(req.status)) return 'LIBRARY';
          if (req.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
          return 'REQUESTED';
      }
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

  const handleRequest = async (id: number, name: string, image: string, year: string, type: 'volume' | 'issue', publisher: string, monitored: boolean = false, directSource?: string) => {
    const targetKey = type === 'volume' ? `vol-${id}` : `iss-${name}`;
    setRequestingTarget(targetKey);
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cvId: id, name, year, publisher: publisher || "Unknown", image, type, monitored, directSource })
      });
      if (res.ok) {
        toast({ title: "Success", description: `${name} added to queue.` })
        if (type === 'volume') {
            setRequestedVolumes(prev => new Set(prev).add(id));
            setOpen(false);
        } else {
            setRequestedIssues(prev => new Set(prev).add(name));
            setActiveRequests(prev => [...prev, { volumeId: id, name: name, status: 'PENDING' }]);
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
  const hasCreators = selectedItem && ((selectedItem.writers?.length ?? 0) > 0 || (selectedItem.artists?.length ?? 0) > 0);

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
          <div className="p-4 border-b border-border bg-muted/30 flex items-center justify-between z-10 transition-colors duration-300">
            <div className="flex items-center gap-2">
              {selectedItem && (<Button variant="ghost" size="sm" onClick={() => setSelectedItem(null)} className="mr-2 -ml-2 text-foreground"><ChevronLeft className="w-4 h-4 mr-1" /> Back</Button>)}
              <DialogTitle className="text-xl font-bold truncate max-w-md text-foreground">{selectedItem ? selectedItem.name : `Results for "${homeQuery}"`}</DialogTitle>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            </div>
            <Button variant="ghost" size="icon" className="text-foreground" onClick={() => setOpen(false)}><X className="h-5 w-5" /></Button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-background transition-colors duration-300">
            {!selectedItem ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 pb-4 px-1">
                  {results.map((item) => {
                    const volStatus = getVolumeStatus(item.id, item.name);
                    return (
                    <div key={item.id} className="cursor-pointer space-y-2 group flex flex-col" onClick={() => handleSelectSearchResult(item)}>
                      <div className="relative aspect-[2/3] w-full rounded-lg overflow-hidden border bg-muted shadow-md border-border transition-colors duration-300">
                        <img src={item.image} alt={item.name} className="absolute inset-0 w-full h-full object-contain transition-transform duration-300 group-hover:scale-105" />
                        {volStatus === 'LIBRARY' && (<div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 z-10 shadow-md"><CheckCircle2 className="w-4 h-4" /></div>)}
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
                              const issueTargetName = selectedItem.isVolume ? `${selectedItem.name.split(' #')[0]} #1` : selectedItem.name;
                              const volStatus = getVolumeStatus(selectedItem.volumeId, selectedItem.name.split(' #')[0]);
                              const issueStatus = getIssueStatus(selectedItem.id, selectedItem.volumeId, issueTargetName);
                              const overallStatus = selectedItem.isVolume ? volStatus : issueStatus;

                              return (
                                <div className="flex flex-col gap-2.5 sm:gap-3 w-full max-w-[300px] mx-auto md:max-w-none mt-2">
                                    {/* VOLUME BUTTONS */}
                                    {volStatus === 'PENDING_APPROVAL' || volStatus === 'REQUESTED' ? (
                                        <Button className="w-full gap-2 shadow-sm h-12 sm:h-10 text-sm font-bold" variant="default" disabled>
                                            {volStatus === 'PENDING_APPROVAL' ? <><Clock className="w-4 h-4 text-yellow-500" /> Pending Approval</> : <><Clock className="w-4 h-4 text-orange-500" /> Requested</>}
                                        </Button>
                                    ) : (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                                            <Button 
                                                className="w-full gap-2 shadow-sm h-12 sm:h-10 text-xs sm:text-sm font-bold px-2" 
                                                variant="default" 
                                                onClick={() => setMonitorPrompt({ id: selectedItem.volumeId, name: selectedItem.name.split(' #')[0], image: selectedItem.image, year: selectedItem.year, publisher: selectedItem.publisher || 'Unknown', directSource: undefined })} 
                                                disabled={requestingTarget === `vol-${selectedItem.volumeId}`}
                                            >
                                                {requestingTarget === `vol-${selectedItem.volumeId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Plus className="w-4 h-4" /> {volStatus === 'LIBRARY' ? 'Update Series' : 'Request Series'}</>}
                                            </Button>
                                            <Button 
                                                className="w-full gap-2 shadow-sm h-12 sm:h-10 text-xs sm:text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white px-2 border-0" 
                                                onClick={() => setMonitorPrompt({ id: selectedItem.volumeId, name: selectedItem.name.split(' #')[0], image: selectedItem.image, year: selectedItem.year, publisher: selectedItem.publisher || 'Unknown', directSource: 'getcomics' })} 
                                                disabled={requestingTarget === `vol-${selectedItem.volumeId}`}
                                                title="Force direct download from GetComics"
                                            >
                                                {requestingTarget === `vol-${selectedItem.volumeId}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Globe className="w-4 h-4" /> GetComics</>}
                                            </Button>
                                        </div>
                                    )}
                                    
                                    {/* ISSUE BUTTONS */}
                                    {issueStatus === 'PENDING_APPROVAL' || issueStatus === 'REQUESTED' || issueStatus === 'LIBRARY' ? (
                                        <Button className={`w-full gap-2 shadow-sm h-12 sm:h-10 text-sm font-bold border-border hover:bg-muted text-foreground`} variant="outline" disabled>
                                            {issueStatus === 'LIBRARY' && <><CheckCircle2 className="w-4 h-4 text-green-500" /> In Library</>}
                                            {issueStatus === 'PENDING_APPROVAL' && <><Clock className="w-4 h-4 text-yellow-500" /> Pending Approval</>}
                                            {issueStatus === 'REQUESTED' && <><Clock className="w-4 h-4 text-orange-500" /> Requested</>}
                                        </Button>
                                    ) : (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full">
                                            <Button 
                                                className="w-full gap-2 shadow-sm h-12 sm:h-10 text-xs sm:text-sm font-bold bg-primary/10 text-primary border-primary/30 hover:bg-primary/20 px-2" 
                                                variant="outline" 
                                                onClick={() => handleRequest(selectedItem.volumeId, issueTargetName, selectedItem.image, selectedItem.year, 'issue', selectedItem.publisher)} 
                                                disabled={requestingTarget === `iss-${issueTargetName}`}
                                            >
                                                {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Download className="w-4 h-4" /> Request Issue</>}
                                            </Button>
                                            <Button 
                                                className="w-full gap-2 shadow-sm h-12 sm:h-10 text-xs sm:text-sm font-bold bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800 px-2" 
                                                variant="outline" 
                                                onClick={() => handleRequest(selectedItem.volumeId, issueTargetName, selectedItem.image, selectedItem.year, 'issue', selectedItem.publisher, false, 'getcomics')} 
                                                disabled={requestingTarget === `iss-${issueTargetName}`}
                                                title="Force direct download from GetComics"
                                            >
                                                {requestingTarget === `iss-${issueTargetName}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Globe className="w-4 h-4" /> GetComics</>}
                                            </Button>
                                        </div>
                                    )}
                                    
                                    <Button 
                                      variant="outline" 
                                      className="w-full gap-2 border-dashed shadow-sm h-12 sm:h-10 text-sm font-bold border-border hover:bg-muted text-foreground" 
                                      onClick={() => setInteractiveQuery({ query: selectedItem.isVolume ? selectedItem.name.split(' #')[0] : selectedItem.name, type: selectedItem.isVolume ? 'issue' : 'volume' })}
                                      disabled={(!selectedItem.isVolume && issueStatus === 'LIBRARY') || overallStatus === 'PENDING_APPROVAL' || overallStatus === 'REQUESTED'}
                                    >
                                        {overallStatus === 'PENDING_APPROVAL' ? (
                                            <><Clock className="w-4 h-4 text-yellow-500" /> Pending Approval</>
                                        ) : overallStatus === 'REQUESTED' ? (
                                            <><Clock className="w-4 h-4 text-orange-500" /> Requested</>
                                        ) : (!selectedItem.isVolume && issueStatus === 'LIBRARY') ? (
                                            <><CheckCircle2 className="w-4 h-4 text-green-500" /> In Library</>
                                        ) : (
                                            <><Search className="w-4 h-4 text-primary" /> Interactive Search</>
                                        )}
                                    </Button>
                                </div>
                              );
                          })()}

                      </div>
                      <div className="space-y-6">
                             {hasCreators && (
                                <div className="grid grid-cols-2 gap-4 bg-muted/50 p-4 rounded-lg border border-border transition-colors duration-300">
                                    {selectedItem.writers?.length > 0 && (<div><p className="text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><PenTool className="w-3 h-3" /> Writer</p><p className="text-sm font-medium text-foreground">{selectedItem.writers.join(", ")}</p></div>)}
                                    {selectedItem.artists?.length > 0 && (<div><p className="text-xs font-bold uppercase text-muted-foreground mb-1 flex items-center gap-1"><Paintbrush className="w-3 h-3" /> Artist</p><p className="text-sm font-medium text-foreground">{selectedItem.artists.join(", ")}</p></div>)}
                                </div>
                             )}

                             {selectedItem.characters && selectedItem.characters.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="font-semibold flex items-center gap-2 text-sm text-foreground"><Users className="w-4 h-4"/> Key Appearances</h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {selectedItem.characters.map((char: string) => (
                                            <Badge key={char} variant="secondary" className="font-medium text-[10px] bg-muted text-foreground border-border hover:bg-muted/80">{char}</Badge>
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
                                          const relIssueStatus = getIssueStatus(issue.id, selectedItem.volumeId, issue.name);
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
                                                      <div className="absolute bottom-2 inset-x-2 z-30 opacity-100 sm:opacity-0 sm:group-hover/issue:opacity-100 transition-opacity flex justify-between items-center pointer-events-none">
                                                          <Button
                                                              size="icon"
                                                              className="h-8 w-8 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg pointer-events-auto"
                                                              disabled={requestingTarget === `iss-${issue.name}`}
                                                              onClick={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  handleRequest(selectedItem.volumeId, issue.name, issue.image, issue.year, 'issue', selectedItem.publisher);
                                                              }}
                                                              title="Standard Request"
                                                          >
                                                              {requestingTarget === `iss-${issue.name}` ? <Loader2 className="w-4 h-4 animate-spin"/> : <Download className="w-4 h-4"/>}
                                                          </Button>
                                                          <Button
                                                              size="icon"
                                                              className="h-8 w-8 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-lg pointer-events-auto border-0"
                                                              disabled={requestingTarget === `iss-${issue.name}`}
                                                              onClick={(e) => {
                                                                  e.preventDefault();
                                                                  e.stopPropagation();
                                                                  handleRequest(selectedItem.volumeId, issue.name, issue.image, issue.year, 'issue', selectedItem.publisher, false, 'getcomics');
                                                              }}
                                                              title="Direct from GetComics"
                                                          >
                                                              {requestingTarget === `iss-${issue.name}` ? <Loader2 className="w-4 h-4 animate-spin"/> : <Globe className="w-4 h-4"/>}
                                                          </Button>
                                                      </div>
                                                  )}

                                                  {relIssueStatus === 'REQUESTED' && (<div className="absolute top-1 left-1 bg-orange-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20">REQUESTED</div>)}
                                                  {relIssueStatus === 'PENDING_APPROVAL' && (<div className="absolute top-1 left-1 bg-yellow-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20" title="Pending Admin Approval">PENDING</div>)}
                                                  {relIssueStatus === 'LIBRARY' && (<div className="absolute top-1 left-1 bg-green-500 text-white rounded-md px-1 py-0.5 text-[8px] font-bold z-20">OWNED</div>)}
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
                <Button variant="secondary" asChild><Link href={selectedItem.siteUrl || `https://comicvine.gamespot.com/volume/4050-${selectedItem.volumeId}/`} target="_blank" rel="noopener noreferrer">ComicVine</Link></Button>
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