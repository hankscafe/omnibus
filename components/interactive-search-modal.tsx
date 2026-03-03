"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
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
  const [gcResults, setGcResults] = useState<any[]>([])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  
  const { toast } = useToast()

  useEffect(() => {
    if (isOpen && initialQuery) {
        setQuery(initialQuery);
        performSearch(initialQuery);
    } else {
        setResults([]);
        setGcResults([]);
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
      if (data.prowlarr) setResults(data.prowlarr);
      if (data.getcomics) setGcResults(data.getcomics);
    } catch (e) {
      toast({ title: "Error", description: "Search failed.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  const handleManualRequest = async (searchResult: any, source: 'prowlarr' | 'getcomics') => {
    // If it's GetComics, use a custom tracking ID so the loading spinner works properly on the automated button
    const trackingId = source === 'getcomics' ? 'getcomics_auto' : (searchResult.infoHash || searchResult.guid || searchResult.downloadUrl);
    setDownloadingId(trackingId);
    
    try {
      const res = await fetch('/api/request/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...comicData,
          name: query, 
          searchResult,
          source
        })
      });

      if (res.ok) {
        toast({ title: "Download Started", description: source === 'getcomics' ? "Automated GetComics search initiated." : "Sent release to download client." });
        onClose();
      } else {
        const err = await res.json();
        toast({ title: "Failed", description: err.error, variant: "destructive" });
      }
    } finally {
      setDownloadingId(null);
    }
  }

  const getAge = (dateString: string) => {
    const diff = Date.now() - new Date(dateString).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Today';
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days/30)}m`;
    return `${Math.floor(days/365)}y`;
  }

  const formatSize = (bytes: number) => {
    if (!bytes) return '-';
    const mb = bytes / (1024 * 1024);
    if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
    return `${mb.toFixed(0)} MB`;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-6xl w-[95%] max-h-[90vh] md:max-h-[85vh] rounded-xl flex flex-col p-0 dark:bg-slate-950 dark:border-slate-800 overflow-hidden">
        <DialogTitle className="sr-only">Interactive Search</DialogTitle>
        <DialogDescription className="sr-only">Manually select a release from Indexers or GetComics.</DialogDescription>

        <div className="p-4 border-b dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 z-10">
           <h2 className="text-xl font-bold mb-4">Interactive Search</h2>
           <div className="flex gap-2">
             <div className="relative flex-1">
               <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 sm:h-4 sm:w-4 text-muted-foreground" />
               <Input 
                 value={query} 
                 onChange={(e) => setQuery(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && performSearch(query)}
                 className="pl-10 sm:pl-9 h-12 sm:h-10 bg-slate-50 dark:bg-slate-950 dark:border-slate-800 text-base sm:text-sm"
               />
             </div>
             <Button onClick={() => performSearch(query)} disabled={loading} className="h-12 sm:h-10 font-bold px-4 sm:px-6">
               {loading ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin sm:mr-2" /> : <Search className="w-5 h-5 sm:w-4 sm:h-4 sm:mr-2" />}
               <span className="hidden sm:inline">Search</span>
             </Button>
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4 bg-slate-50 dark:bg-slate-950/50 space-y-4 sm:space-y-6">
            
            {/* GetComics Banner */}
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-sm">
                <div>
                    <h3 className="font-bold text-blue-900 dark:text-blue-400 flex items-center gap-2">
                        <Globe className="w-5 h-5"/> GetComics Automation
                    </h3>
                    <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                        {gcResults.length > 0 ? `Found: ${gcResults[0].title}` : `Force automatic fallback search for "${query}".`}
                    </p>
                </div>
                <Button 
                    className="w-full sm:w-auto h-12 sm:h-10 font-bold shrink-0 bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
                    onClick={() => handleManualRequest({ title: query }, 'getcomics')}
                    disabled={downloadingId !== null}
                >
                    {downloadingId === 'getcomics_auto' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2" /> : <Download className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />}
                    Automate GetComics
                </Button>
            </div>

            {/* --- DESKTOP VIEW (Hidden on Mobile) --- */}
            <div className="hidden md:block border dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-950 shadow-sm">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-slate-50 dark:bg-slate-900 border-b dark:border-slate-800">
                        <tr>
                            <th className="px-4 py-3">Protocol</th>
                            <th className="px-4 py-3">Age</th>
                            <th className="px-4 py-3 w-[40%]">Title</th>
                            <th className="px-4 py-3">Indexer</th>
                            <th className="px-4 py-3">Size</th>
                            <th className="px-4 py-3">Peers/Grabs</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-slate-800">
                        {loading ? (
                            <tr><td colSpan={7} className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
                        ) : results.filter(r => !hiddenIds.has(r.guid || r.infoHash)).length === 0 ? (
                            <tr><td colSpan={7} className="text-center py-10 text-muted-foreground italic">No indexer results found.</td></tr>
                        ) : (
                            results.filter(r => !hiddenIds.has(r.guid || r.infoHash)).map((res, idx) => {
                                const trackingId = res.guid || res.infoHash;
                                const isTorrent = res.protocol === 'torrent';
                                
                                return (
                                <tr key={trackingId || idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/50">
                                    <td className="px-4 py-3">
                                        <Badge variant="outline" className={isTorrent ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : "text-purple-600 border-purple-200 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-800"}>
                                            {isTorrent ? <Database className="w-3 h-3 mr-1"/> : <HardDrive className="w-3 h-3 mr-1"/>}
                                            {res.protocol}
                                        </Badge>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs">{getAge(res.publishDate)}</td>
                                    <td className="px-4 py-3 font-medium break-all leading-tight">{res.title}</td>
                                    <td className="px-4 py-3 text-muted-foreground">{res.indexer}</td>
                                    <td className="px-4 py-3 font-mono text-xs">{formatSize(res.size)}</td>
                                    <td className="px-4 py-3">
                                        <div className="flex flex-col text-xs text-muted-foreground">
                                            {isTorrent ? (
                                                <span className="flex items-center gap-1 text-green-600 dark:text-green-400 font-bold"><Users className="w-3 h-3"/> S: {res.seeders} / L: {res.leechers}</span>
                                            ) : (
                                                <span>Grabs: {res.grabs || 0}</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center justify-end gap-2">
                                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setHiddenIds(prev => new Set(prev).add(trackingId))} title="Hide/Block Release">
                                                <Ban className="w-4 h-4" />
                                            </Button>
                                            <Button size="sm" onClick={() => handleManualRequest(res, 'prowlarr')} disabled={downloadingId !== null} className="font-bold">
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

            {/* --- MOBILE STACKED CARDS VIEW (Hidden on Desktop) --- */}
            <div className="md:hidden space-y-3 pb-6">
                {loading ? (
                    <div className="text-center py-10"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>
                ) : results.filter(r => !hiddenIds.has(r.guid || r.infoHash)).length === 0 ? (
                    <div className="text-center py-10 text-muted-foreground italic bg-white dark:bg-slate-950 rounded-lg border dark:border-slate-800">No indexer results found.</div>
                ) : (
                    results.filter(r => !hiddenIds.has(r.guid || r.infoHash)).map((res, idx) => {
                        const trackingId = res.guid || res.infoHash;
                        const isTorrent = res.protocol === 'torrent';
                        
                        return (
                        <div key={trackingId || idx} className="flex flex-col gap-3 p-4 bg-white dark:bg-slate-950 border dark:border-slate-800 rounded-lg shadow-sm">
                            <div className="font-bold text-sm break-all leading-tight text-slate-900 dark:text-slate-100">
                                {res.title}
                            </div>
                            
                            <div className="flex flex-wrap gap-2 items-center">
                                <Badge variant="outline" className={`text-[10px] uppercase tracking-wider px-1.5 ${isTorrent ? "text-green-600 border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800" : "text-purple-600 border-purple-200 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-800"}`}>
                                    {isTorrent ? <Database className="w-3 h-3 mr-1"/> : <HardDrive className="w-3 h-3 mr-1"/>}
                                    {res.protocol}
                                </Badge>
                                <Badge variant="secondary" className="font-mono text-[10px] px-1.5">{getAge(res.publishDate)}</Badge>
                                <Badge variant="secondary" className="font-mono text-[10px] px-1.5">{formatSize(res.size)}</Badge>
                                {isTorrent ? (
                                    <span className="flex items-center gap-1 text-green-600 dark:text-green-400 font-black text-[10px]"><Users className="w-3 h-3"/> S:{res.seeders}</span>
                                ) : (
                                    <span className="font-black text-[10px] text-muted-foreground">Grabs: {res.grabs || 0}</span>
                                )}
                            </div>

                            <div className="flex items-center justify-between pt-3 border-t dark:border-slate-800 mt-1">
                                <span className="text-xs text-muted-foreground font-medium truncate pr-2">{res.indexer}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                    <Button variant="outline" size="icon" className="h-10 w-10 text-red-500 hover:bg-red-50 border-red-200 dark:border-red-900/50 dark:hover:bg-red-900/20" onClick={() => setHiddenIds(prev => new Set(prev).add(trackingId))} title="Hide/Block Release">
                                        <Ban className="w-5 h-5" />
                                    </Button>
                                    <Button size="sm" className="h-10 px-4 font-bold shadow-sm" onClick={() => handleManualRequest(res, 'prowlarr')} disabled={downloadingId !== null}>
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
  )
}