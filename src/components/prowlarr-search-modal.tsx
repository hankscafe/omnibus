"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2, Cloud, Wifi } from "lucide-react"

interface SearchResult {
  title: string;
  size: number;
  indexer: string;
  guid: string;
  infoHash?: string; 
  seeders: number;
  leechers: number;
  publishDate: string;
  protocol: string;
}

interface Props {
  requestId: string; 
  seriesName: string;
  seriesYear: number;
}

export function ProwlarrSearchModal({ requestId, seriesName, seriesYear }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [results, setResults] = useState<SearchResult[]>([])
  const [query, setQuery] = useState(`${seriesName} ${seriesYear}`)

  const handleSearch = async () => {
    setLoading(true)
    setResults([])
    try {
      const res = await fetch(`/api/admin/search-prowlarr?q=${encodeURIComponent(query)}`)
      const data = await res.json()
      if (data.results) setResults(data.results)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const onOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (isOpen && results.length === 0) {
      handleSearch()
    }
  }

  const handleDownload = async (release: SearchResult) => {
    setDownloading(release.guid)
    try {
      const res = await fetch('/api/admin/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: requestId,
          guid: release.guid,
          infoHash: release.infoHash, 
          title: release.title,
          protocol: release.protocol
        })
      });

      const data = await res.json();
      if (data.success) {
        setOpen(false); 
      } else {
        alert("Failed: " + data.error);
      }
    } catch (e) {
      console.error(e);
      alert("Error sending download request.");
    } finally {
      setDownloading(null);
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Search Prowlarr</Button>
      </DialogTrigger>
      
      {/* --- FIX 5a: Standard Dialog Size --- */}
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col p-0 gap-0">
        <div className="p-6 border-b shrink-0 bg-white z-20">
          <DialogHeader>
            <DialogTitle>Search Results: {seriesName}</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2 mt-4 max-w-2xl">
            <input 
              className="flex-1 px-3 py-2 border rounded-md text-sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button onClick={handleSearch} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden relative bg-slate-50/50">
          <ScrollArea className="h-full w-full">
            <div className="p-4">
              <Table>
                <TableHeader className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                  <TableRow>
                    <TableHead className="w-[50%]">Release Name</TableHead>
                    <TableHead className="w-[15%]">Indexer</TableHead>
                    <TableHead className="w-[10%]">Size</TableHead>
                    <TableHead className="w-[10%]">Seeds</TableHead>
                    <TableHead className="w-[15%] text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                        No results found.
                      </TableCell>
                    </TableRow>
                  )}
                  
                  {results.map((item, idx) => (
                    <TableRow key={idx} className="hover:bg-slate-100/80">
                      <TableCell className="font-medium">
                        <div className="truncate max-w-[400px] xl:max-w-[600px]" title={item.title}>
                          {item.title}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Cloud className="w-3 h-3" /> {item.indexer}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                         {formatSize(item.size)}
                      </TableCell>
                      <TableCell>
                        <div className={`flex items-center gap-1 text-xs font-bold ${item.seeders > 0 ? "text-green-600" : "text-red-500"}`}>
                          <Wifi className="w-3 h-3" /> {item.seeders}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          size="sm" 
                          onClick={() => handleDownload(item)}
                          disabled={downloading === item.guid}
                          className={item.seeders === 0 ? "opacity-50" : ""}
                        >
                          {downloading === item.guid ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            "Download"
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}