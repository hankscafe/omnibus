"use client"

import { useState, useEffect } from "react"
// Added DialogHeader to the import here!
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
  }
}

export function InteractiveSearchModal({ isOpen, onClose, initialQuery, comicData }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<any[]>([])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  
  // New State for Monitor Prompt
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

  // Intercept download action to show monitor prompt if it's a volume search
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
          monitored
        })
      });

      if (res.ok) {
        toast({ title: "Success", description: source === 'flag_admin' ? "Flagged for manual admin import." : "Download requested." });
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
      <DialogContent className="sm:max-w-6xl w-[95%] max-h-[90vh] md:max-h-[85vh] rounded-xl flex flex-col p-0 bg-background border-border overflow-hidden transition-colors duration-300">
        <DialogTitle className="sr-only">Interactive Search</DialogTitle>
        <DialogDescription className="sr-only">Manually select a release from Indexers or GetComics.</DialogDescription>

        <div className="p-4 border-b border-border bg-background shrink-0 z-10">
           <h2 className="text-xl font-bold mb-4 text-foreground">Interactive Search</h2>
           <div className="flex gap-2">
             <div className="relative flex-1">
               <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 sm:h-4 sm:w-4 text-muted-foreground" />
               <Input 
                 value={query} 
                 onChange={(e) => setQuery(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && performSearch(query)}
                 className="pl-10 sm:pl-9 h-12 sm:h-10 bg-muted/50 border-border text-base sm:text-sm text-foreground"
               />
             </div>
             <Button onClick={() => performSearch(query)} disabled={loading} className="h-12 sm:h-10 font-bold px-4 sm:px-6 bg-primary hover:bg-primary/90 text-primary-foreground">
               {loading ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin sm:mr-2" /> : <Search className="w-5 h-5 sm:w-4 sm:h-4 sm:mr-2" />}
               <span className="hidden sm:inline">Search</span>
             </Button>
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4 bg-muted/30 space-y-4 sm:space-y-6">
            <div className="bg-background border border-border rounded-lg p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-sm mb-4">
                <div>
                    <h3 className="font-bold text-foreground flex items-center gap-2">
                        <Ban className="w-5 h-5 text-red-500"/> Can't find what you're looking for?
                    </h3>
                    <p className="text-sm text-muted-foreground mt-1">
                        Send a manual request to the server admins to find and import this comic.
                    </p>
                </div>
                <Button 
                    variant="destructive"
                    className="w-full sm:w-auto h-10 font-bold shrink-0 shadow-sm"
                    onClick={() => initiateManualRequest({ title: query }, 'flag_admin')}
                    disabled={downloadingId !== null}
                >
                    {downloadingId === 'flag_admin' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Ban className="w-4 h-4 mr-2" />}
                    Flag for Admin
                </Button>
            </div>

            <div className="hidden md:block border border-border rounded-lg overflow-hidden bg-background shadow-sm">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted border-b border-border">
                        <tr>
                            <th className="px-4 py-3">Protocol</th>
                            <th className="px-4 py-3">Age</th>
                            <th className="px-4 py-3 w-[40%]">Title</th>
                            <th className="px-4 py-3">Indexer</th>
                            <th className="px-4 py-3">Size</th>
                            <th className="px-4 py-3">Peers</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y border-border">
                        {loading ? (
                            <tr><td colSpan={7} className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></td></tr>
                        ) : results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).length === 0 ? (
                            <tr><td colSpan={7} className="text-center py-10 text-muted-foreground italic">No results found.</td></tr>
                        ) : (
                            results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).map((res, idx) => {
                                const trackingId = res.guid || res.infoHash || res.downloadUrl;
                                const isTorrent = res.protocol === 'torrent';
                                const isDdl = res.protocol === 'ddl';
                                return (
                                <tr key={trackingId || idx} className="hover:bg-muted/50 transition-colors">
                                    <td className="px-4 py-3">
                                        <Badge variant="outline" className={isTorrent ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : isDdl ? "text-primary border-primary/30 bg-primary/10" : "text-purple-600 border-purple-200 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-800"}>
                                            {isTorrent ? <Database className="w-3 h-3 mr-1"/> : isDdl ? <Globe className="w-3 h-3 mr-1"/> : <HardDrive className="w-3 h-3 mr-1"/>}
                                            {isDdl ? 'Direct' : res.protocol}
                                        </Badge>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-foreground">{isDdl ? res.age : getAge(res.publishDate)}</td>
                                    <td className="px-4 py-3 font-medium text-foreground break-all leading-tight">{res.title}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{res.indexer}</td>
                                    <td className="px-4 py-3 font-mono text-xs text-foreground">{isDdl ? res.size : formatSize(res.size)}</td>
                                    <td className="px-4 py-3 text-xs text-muted-foreground">{isTorrent ? <span className="flex items-center gap-1 text-green-600 dark:text-green-400 font-bold"><Users className="w-3 h-3"/> S: {res.seeders}</span> : isDdl ? "-" : `Grabs: ${res.grabs || 0}`}</td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setHiddenIds(prev => new Set(prev).add(trackingId))} title="Hide/Block Release"><Ban className="w-4 h-4" /></Button>
                                            <Button size="sm" onClick={() => initiateManualRequest(res, isDdl ? 'getcomics' : 'prowlarr')} disabled={downloadingId !== null} className="font-bold bg-primary text-primary-foreground hover:bg-primary/90">
                                                {downloadingId === trackingId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            )})
                        )}
                    </tbody>
                </table>
            </div>

            <div className="md:hidden space-y-3 pb-6">
                {loading ? (
                    <div className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></div>
                ) : results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).length === 0 ? (
                    <div className="text-center py-10 text-muted-foreground italic bg-background rounded-lg border border-border">No results found.</div>
                ) : (
                    results.filter(r => !hiddenIds.has(r.guid || r.infoHash || r.downloadUrl)).map((res, idx) => {
                        const trackingId = res.guid || res.infoHash || res.downloadUrl;
                        const isTorrent = res.protocol === 'torrent';
                        const isDdl = res.protocol === 'ddl';
                        return (
                        <div key={trackingId || idx} className="flex flex-col gap-3 p-4 bg-background border border-border rounded-lg shadow-sm">
                            <div className="font-bold text-sm break-all leading-tight text-foreground">{res.title}</div>
                            <div className="flex flex-wrap gap-2 items-center">
                                <Badge variant="outline" className={`text-[10px] uppercase tracking-wider px-1.5 ${isTorrent ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : isDdl ? "text-primary border-primary/30 bg-primary/10" : "text-purple-600 border-purple-200 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-800"}`}>
                                    {isTorrent ? <Database className="w-3 h-3 mr-1"/> : isDdl ? <Globe className="w-3 h-3 mr-1"/> : <HardDrive className="w-3 h-3 mr-1"/>}
                                    {isDdl ? 'Direct' : res.protocol}
                                </Badge>
                                <Badge variant="secondary" className="font-mono text-[10px] px-1.5 bg-muted text-muted-foreground">{isDdl ? res.age : getAge(res.publishDate)}</Badge>
                                <Badge variant="secondary" className="font-mono text-[10px] px-1.5 bg-muted text-muted-foreground">{isDdl ? res.size : formatSize(res.size)}</Badge>
                            </div>
                            <div className="flex items-center justify-between pt-3 border-t border-border mt-1">
                                <span className="text-xs text-muted-foreground font-medium truncate pr-2">{res.indexer}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Button variant="outline" size="icon" className="h-10 w-10 text-red-500 hover:bg-red-50 border-border dark:hover:bg-red-900/20" onClick={() => setHiddenIds(prev => new Set(prev).add(trackingId))} title="Hide/Block Release"><Ban className="w-5 h-5" /></Button>
                                    <Button size="sm" className="h-10 px-4 font-bold shadow-sm bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => initiateManualRequest(res, isDdl ? 'getcomics' : 'prowlarr')} disabled={downloadingId !== null}>
                                        {downloadingId === trackingId ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Download className="w-5 h-5 mr-1.5" /> Get</>}
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

    {/* MONITOR PROMPT DIALOG */}
    <Dialog open={!!monitorPrompt} onOpenChange={(open) => !open && setMonitorPrompt(null)}>
        <DialogContent className="sm:max-w-md bg-background border-border rounded-xl w-[95%]">
          <DialogHeader>
              <DialogTitle className="text-xl font-bold text-foreground">Monitor Series?</DialogTitle>
              <DialogDescription className="text-sm sm:text-base text-muted-foreground mt-2">
                You are requesting the series <strong>{monitorPrompt?.result.title || "this comic"}</strong>. Would you like Omnibus to automatically monitor this series and download new issues as they are released in the future?
              </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 mt-4 sm:mt-6">
            <Button className="w-full h-12 sm:h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold" onClick={() => {
                if (monitorPrompt) handleManualRequest(monitorPrompt.result, monitorPrompt.source, true);
            }}>
                Yes, Download & Monitor
            </Button>
            <Button variant="outline" className="w-full h-12 sm:h-10 font-bold border-primary/30 text-primary bg-primary/10 hover:bg-primary/20" onClick={() => {
                if (monitorPrompt) handleManualRequest(monitorPrompt.result, monitorPrompt.source, false);
            }}>
                No, Just Download This File
            </Button>
            <Button variant="ghost" className="w-full h-12 sm:h-10 font-bold text-muted-foreground" onClick={() => setMonitorPrompt(null)}>Cancel</Button>
          </div>
        </DialogContent>
    </Dialog>
    </>
  )
}