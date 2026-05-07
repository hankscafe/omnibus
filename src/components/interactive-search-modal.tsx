"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Search, Loader2, Download, Ban, Globe, HardDrive, Users, Database } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialQuery: string;
  comicData: {
    cvId: number;
    year: string;
    publisher: string;
    image: string;
    type: 'volume' | 'issue';
  };
  requestId?: string;
}

export function InteractiveSearchModal({ isOpen, onClose, initialQuery, comicData, requestId }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<any[]>([])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  
  const [monitorPrompt, setMonitorPrompt] = useState<{ result: any, source: 'prowlarr' | 'getcomics' } | null>(null)
  
  const { toast } = useToast()

  useEffect(() => {
    if (isOpen && initialQuery) {
        setQuery(initialQuery);
        performSearch(initialQuery);
    } else {
        setResults([]);
        setHiddenIds(new Set());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialQuery])

  const performSearch = async (searchQuery: string) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/search/interactive?q=${encodeURIComponent(searchQuery)}`)
      const data = await res.json()
      const combined = [];
      if (data.prowlarr) combined.push(...data.prowlarr);
      if (data.getcomics) combined.push(...data.getcomics);
      setResults(combined);
    } catch (e) {
      toast({ title: "Error", description: "Search failed.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  const initiateManualRequest = (searchResult: any, source: 'prowlarr' | 'getcomics' | 'flag_admin') => {
      if (source !== 'flag_admin' && comicData.type === 'volume') {
          setMonitorPrompt({ result: searchResult, source: source as 'prowlarr' | 'getcomics' });
      } else {
          handleManualRequest(searchResult, source, false);
      }
  }

  const handleManualRequest = async (searchResult: any, source: 'prowlarr' | 'getcomics' | 'flag_admin', monitored: boolean) => {
    const trackingId = source === 'flag_admin' ? 'flag_admin' : (searchResult.infoHash || searchResult.guid || searchResult.downloadUrl);
    setDownloadingId(trackingId);
    
    try {
      const res = await fetch('/api/request/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...comicData,
          name: query, 
          searchResult,
          source,
          monitored,
          requestId
        })
      });

      if (res.ok) {
        const data = await res.json();
        toast({ title: "Success", description: data.message || (source === 'flag_admin' ? "Flagged for manual admin import." : "Download requested.") });
        onClose();
      } else {
        const err = await res.json();
        toast({ title: "Failed", description: err.error, variant: "destructive" });
      }
    } finally {
      setDownloadingId(null);
      setMonitorPrompt(null);
    }
  }

  const formatSize = (bytes: number) => {
    if (!bytes) return '-';
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(0)} MB`;
  }

  const getAge = (dateString: string) => {
    if (!dateString) return 'N/A';
    const diff = Date.now() - new Date(dateString).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Today';
    return `${days}d`;
  }

  return (
    <>
    <Dialog open={isOpen} onOpenChange={onClose}>
      {/* THE FIX: Dynamic viewport widths (w-[95vw] lg:max-w-6xl) to stretch perfectly across all screens */}
      <DialogContent className="max-w-[95vw] lg:max-w-6xl w-full max-h-[90vh] rounded-xl flex flex-col p-0 bg-background border-border overflow-hidden transition-colors duration-300">
        <DialogTitle className="sr-only">Interactive Search</DialogTitle>
        <DialogDescription className="sr-only">Manually select a release from Indexers or GetComics.</DialogDescription>

        <div className="p-4 sm:p-6 border-b border-border bg-background shrink-0 z-10">
           <h2 className="text-xl sm:text-2xl font-bold mb-4 text-foreground">Interactive Search</h2>
           <div className="flex gap-2 sm:gap-3">
             <div className="relative flex-1">
               <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
               <Input 
                 value={query} 
                 onChange={(e) => setQuery(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && performSearch(query)}
                 className="pl-10 h-12 sm:h-12 bg-muted/50 border-border text-base text-foreground"
               />
             </div>
             <Button onClick={() => performSearch(query)} disabled={loading} className="h-12 sm:h-12 font-bold px-5 sm:px-8 bg-primary hover:bg-primary/90 text-primary-foreground text-base">
               {loading ? <Loader2 className="w-5 h-5 animate-spin sm:mr-2" /> : <Search className="w-5 h-5 sm:mr-2" />}
               <span className="hidden sm:inline">Search</span>
             </Button>
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-muted/30 space-y-4 sm:space-y-6">
            <div className="bg-background border border-border rounded-lg p-4 sm:p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-sm mb-2">
                <div>
                    <h3 className="font-bold text-foreground flex items-center gap-2 text-base sm:text-lg">
                        <Ban className="w-5 h-5 text-red-500"/> Can't find what you're looking for?
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                        Send a manual request to the server admins to find and import this comic.
                    </p>
                </div>
                <Button 
                    variant="destructive"
                    className="w-full md:w-auto h-11 font-bold shrink-0 shadow-sm"
                    onClick={() => initiateManualRequest({ title: query }, 'flag_admin')}
                    disabled={downloadingId !== null}
                >
                    {downloadingId === 'flag_admin' ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Ban className="w-5 h-5 mr-2" />}
                    Flag for Admin
                </Button>
            </div>

            {/* THE FIX: Desktop Table View (md and up) */}
            <div className="hidden lg:block border border-border rounded-lg overflow-hidden bg-background shadow-sm">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted border-b border-border">
                        <tr>
                            {/* whitespace-nowrap and w-[1%] force the data columns to perfectly hug their content without squishing */}
                            <th className="px-4 py-3 whitespace-nowrap w-[1%]">Protocol</th>
                            <th className="px-4 py-3 whitespace-nowrap w-[1%]">Age</th>
                            <th className="px-4 py-3">Title</th>
                            <th className="px-4 py-3 whitespace-nowrap w-[1%]">Indexer</th>
                            <th className="px-4 py-3 whitespace-nowrap w-[1%]">Size</th>
                            <th className="px-4 py-3 whitespace-nowrap w-[1%]">Peers</th>
                            <th className="px-4 py-3 whitespace-nowrap w-[1%] text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y border-border">
                        {loading ? (
                            <tr><td colSpan={7} className="text-center py-12"><Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" /></td></tr>
                        ) : results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).length === 0 ? (
                            <tr><td colSpan={7} className="text-center py-12 text-muted-foreground italic text-base">No results found.</td></tr>
                        ) : (
                            results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).map((res, idx) => {
                                const trackingId = res.guid || res.infoHash || res.downloadUrl;
                                const isTorrent = res.protocol === 'torrent';
                                const isDdl = res.protocol === 'ddl';
                                return (
                                <tr key={trackingId || idx} className="hover:bg-muted/50 transition-colors">
                                    <td className="px-4 py-3 whitespace-nowrap">
                                        <Badge variant="outline" className={isTorrent ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : isDdl ? "text-primary border-primary/30 bg-primary/10" : "text-purple-600 border-purple-200 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-800"}>
                                            {isTorrent ? <Database className="w-3 h-3 mr-1"/> : isDdl ? <Globe className="w-3 h-3 mr-1"/> : <HardDrive className="w-3 h-3 mr-1"/>}
                                            {isDdl ? 'Direct' : res.protocol}
                                        </Badge>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-sm text-foreground whitespace-nowrap">{isDdl ? res.age : getAge(res.publishDate)}</td>
                                    {/* Title column soaks up all remaining flexible space */}
                                    <td className="px-4 py-3 font-medium text-foreground break-words leading-tight">{res.title}</td>
                                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{res.indexer}</td>
                                    <td className="px-4 py-3 font-mono text-sm text-foreground whitespace-nowrap">{isDdl ? res.size : formatSize(res.size)}</td>
                                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">{isTorrent ? <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-bold"><Users className="w-4 h-4"/> S: {res.seeders}</span> : isDdl ? "-" : `Grabs: ${res.grabs || 0}`}</td>
                                    <td className="px-4 py-3 whitespace-nowrap">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button variant="ghost" size="icon" className="h-9 w-9 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setHiddenIds(prev => new Set(prev).add(trackingId))} title="Hide/Block Release"><Ban className="w-4 h-4" /></Button>
                                            <Button size="sm" onClick={() => initiateManualRequest(res, isDdl ? 'getcomics' : 'prowlarr')} disabled={downloadingId !== null} className="font-bold h-9 bg-primary text-primary-foreground hover:bg-primary/90">
                                                {downloadingId === trackingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Download className="w-4 h-4 mr-2" /> Download</>}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            )})
                        )}
                    </tbody>
                </table>
            </div>

            {/* THE FIX: Mobile Card View (hidden on lg screens and up) */}
            <div className="lg:hidden space-y-4 pb-6">
                {loading ? (
                    <div className="text-center py-12"><Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" /></div>
                ) : results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground italic bg-background rounded-lg border border-border text-base">No results found.</div>
                ) : (
                    results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).map((res, idx) => {
                        const trackingId = res.guid || res.infoHash || res.downloadUrl;
                        const isTorrent = res.protocol === 'torrent';
                        const isDdl = res.protocol === 'ddl';
                        return (
                        <div key={trackingId || idx} className="flex flex-col gap-3 p-4 sm:p-5 bg-background border border-border rounded-lg shadow-sm">
                            <div className="font-bold text-base break-words leading-tight text-foreground">{res.title}</div>
                            <div className="flex flex-wrap gap-2 items-center">
                                <Badge variant="outline" className={`text-xs uppercase tracking-wider px-2 py-0.5 ${isTorrent ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : isDdl ? "text-primary border-primary/30 bg-primary/10" : "text-purple-600 border-purple-200 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-800"}`}>
                                    {isTorrent ? <Database className="w-3.5 h-3.5 mr-1.5"/> : isDdl ? <Globe className="w-3.5 h-3.5 mr-1.5"/> : <HardDrive className="w-3.5 h-3.5 mr-1.5"/>}
                                    {isDdl ? 'Direct' : res.protocol}
                                </Badge>
                                <Badge variant="secondary" className="font-mono text-xs px-2 py-0.5 bg-muted text-muted-foreground">{isDdl ? res.age : getAge(res.publishDate)}</Badge>
                                <Badge variant="secondary" className="font-mono text-xs px-2 py-0.5 bg-muted text-muted-foreground">{isDdl ? res.size : formatSize(res.size)}</Badge>
                                {isTorrent && <Badge variant="outline" className="text-xs px-2 py-0.5 border-green-200 text-green-600 bg-green-50 dark:bg-green-900/20 dark:text-green-400">S: {res.seeders}</Badge>}
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-border mt-2">
                                <span className="text-sm text-muted-foreground font-medium truncate">{res.indexer}</span>
                                <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                                    <Button variant="outline" size="icon" className="h-11 w-11 text-red-500 hover:bg-red-50 border-border dark:hover:bg-red-900/20 shrink-0" onClick={() => setHiddenIds(prev => new Set(prev).add(trackingId))} title="Hide/Block Release"><Ban className="w-5 h-5" /></Button>
                                    <Button size="sm" className="h-11 flex-1 sm:px-6 font-bold shadow-sm bg-primary hover:bg-primary/90 text-primary-foreground text-sm" onClick={() => initiateManualRequest(res, isDdl ? 'getcomics' : 'prowlarr')} disabled={downloadingId !== null}>
                                        {downloadingId === trackingId ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Download className="w-5 h-5 mr-2" /> Download</>}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )})
                )}
            </div>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog open={!!monitorPrompt} onOpenChange={(open) => !open && setMonitorPrompt(null)}>
        <DialogContent className="sm:max-w-md bg-background border-border rounded-xl w-[95vw]">
          <DialogHeader>
              <DialogTitle className="text-xl font-bold text-foreground">Monitor Series?</DialogTitle>
              <DialogDescription className="text-base text-muted-foreground mt-2">
                You are requesting the series <strong>{monitorPrompt?.result.title || "this comic"}</strong>. Would you like Omnibus to automatically monitor this series and download new issues as they are released in the future?
              </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-6">
            <Button className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-base" onClick={() => {
                if (monitorPrompt) handleManualRequest(monitorPrompt.result, monitorPrompt.source, true);
            }}>
                Yes, Download & Monitor
            </Button>
            <Button variant="outline" className="w-full h-12 font-bold border-primary/30 text-primary bg-primary/10 hover:bg-primary/20 text-base" onClick={() => {
                if (monitorPrompt) handleManualRequest(monitorPrompt.result, monitorPrompt.source, false);
            }}>
                No, Just Download This File
            </Button>
            <Button variant="ghost" className="w-full h-12 font-bold text-muted-foreground text-base" onClick={() => setMonitorPrompt(null)}>Cancel</Button>
          </div>
        </DialogContent>
    </Dialog>
    </>
  )
}