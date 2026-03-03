"use client"

import { useState, useEffect } from "react"
import { useSession } from "next-auth/react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { HardDrive, Loader2, Database, LayoutList, Layers, ChevronLeft, AlertTriangle, RefreshCw, Clock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"

function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes'
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

function timeAgo(timestampStr: string | null) {
    if (!timestampStr) return "Never";
    const seconds = Math.floor((Date.now() - parseInt(timestampStr)) / 1000);
    if (seconds < 60) return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export default function StorageDeepDivePage() {
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'ADMIN'
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [isScanning, setIsScanning] = useState(false)
  const [storageData, setStorageData] = useState<any[]>([])
  const [totalBytes, setTotalBytes] = useState(0)
  const [lastRun, setLastRun] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin) return;
    
    fetch('/api/admin/storage')
      .then(res => res.json())
      .then(data => {
        if (data.series) {
            setStorageData(data.series);
            const total = data.series.reduce((acc: number, curr: any) => acc + curr.sizeBytes, 0);
            setTotalBytes(total);
            setLastRun(data.lastRun);
            
            // Auto-trigger scan if cache is empty
            if (data.needsScan) handleTriggerScan();
        }
      })
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [isAdmin])

  const handleTriggerScan = async () => {
      setIsScanning(true);
      toast({ title: "Scan Started", description: "Calculating physical sizes in the background. Refresh this page in a few minutes." });
      try {
          await fetch('/api/admin/jobs/trigger', { 
              method: 'POST', 
              headers: { 'Content-Type': 'application/json' }, 
              body: JSON.stringify({ job: 'storage_scan' }) 
          });
      } catch (e) {
      } finally {
          setIsScanning(false);
      }
  }

  if (!isAdmin) return <div className="p-10 text-center">Unauthorized</div>;

  return (
    <div className="container mx-auto py-10 px-6 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" asChild className="shrink-0">
                  <Link href="/admin/analytics"><ChevronLeft className="w-5 h-5" /></Link>
              </Button>
              <div>
                  <h1 className="text-3xl font-black tracking-tight flex items-center gap-3">
                      <HardDrive className="w-8 h-8 text-indigo-500" /> Storage Deep Dive
                  </h1>
                  <p className="text-muted-foreground mt-1 font-medium">Find out which series are consuming the most space on your drive.</p>
              </div>
          </div>
          
          <div className="flex flex-col items-end gap-2">
              <Button variant="outline" size="sm" onClick={handleTriggerScan} disabled={isScanning || loading} className="shadow-sm">
                  <RefreshCw className={`w-4 h-4 mr-2 ${isScanning ? 'animate-spin' : ''}`} /> 
                  {isScanning ? 'Scanning Disk...' : 'Force Scan Now'}
              </Button>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Updated: {timeAgo(lastRun)}
              </span>
          </div>
      </div>

      {loading ? (
          <div className="py-20 flex justify-center"><Loader2 className="w-10 h-10 animate-spin text-indigo-500" /></div>
      ) : (
          <div className="space-y-6 animate-in fade-in duration-500">
              {/* TOTAL STORAGE SUMMARY CARD */}
              <Card className="p-6 bg-indigo-600 text-white shadow-lg border-0 overflow-hidden relative">
                  <Database className="absolute -bottom-6 -right-6 w-32 h-32 opacity-10 rotate-12" />
                  <div className="relative z-10 flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
                      <div>
                          <p className="text-indigo-200 font-black tracking-widest uppercase text-xs mb-1">Total Library Size</p>
                          <h2 className="text-5xl font-black tracking-tighter">{formatBytes(totalBytes)}</h2>
                      </div>
                      <div className="flex gap-2">
                          <Badge variant="secondary" className="bg-white/20 hover:bg-white/30 text-white border-0">
                              {storageData.length} Series
                          </Badge>
                          <Badge variant="secondary" className="bg-white/20 hover:bg-white/30 text-white border-0">
                              {storageData.reduce((acc, curr) => acc + curr.issueCount, 0)} Issues
                          </Badge>
                      </div>
                  </div>
              </Card>

              {/* THE DEEP DIVE TABLE */}
              <div className="border dark:border-slate-800 rounded-xl bg-white dark:bg-slate-950 overflow-hidden shadow-sm">
                  <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                          <thead className="text-xs text-muted-foreground uppercase bg-slate-50 dark:bg-slate-900/80 border-b dark:border-slate-800 font-black tracking-wider">
                              <tr>
                                  <th className="px-6 py-4">Series Name</th>
                                  <th className="px-6 py-4 text-center hidden sm:table-cell">Issues</th>
                                  <th className="px-6 py-4 w-1/3">Storage Usage</th>
                                  <th className="px-6 py-4 text-right">Size</th>
                              </tr>
                          </thead>
                          <tbody className="divide-y dark:divide-slate-800">
                              {storageData.map((item, index) => {
                                  const percentage = totalBytes > 0 ? (item.sizeBytes / totalBytes) * 100 : 0;
                                  // Highlight the top 3 biggest offenders
                                  const isMassive = index < 3 && item.sizeBytes > 0; 
                                  
                                  return (
                                      <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors group">
                                          <td className="px-6 py-4">
                                              <div className="flex flex-col">
                                                  <Link href={`/library/series?path=${encodeURIComponent(item.path)}`} className="font-bold text-base text-slate-900 dark:text-slate-100 hover:text-indigo-600 dark:hover:text-indigo-400 truncate max-w-[250px] sm:max-w-[300px]">
                                                      {item.name}
                                                  </Link>
                                                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground mt-0.5 flex items-center gap-1">
                                                      {item.isManga ? <Layers className="w-3 h-3" /> : <LayoutList className="w-3 h-3" />} 
                                                      {item.publisher}
                                                  </span>
                                              </div>
                                          </td>
                                          <td className="px-6 py-4 text-center hidden sm:table-cell">
                                              <Badge variant="outline" className="font-mono bg-slate-50 dark:bg-slate-900">
                                                  {item.issueCount}
                                              </Badge>
                                          </td>
                                          <td className="px-6 py-4">
                                              <div className="w-full flex items-center gap-3">
                                                  <div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden border dark:border-slate-700">
                                                      <div 
                                                        className={`h-full rounded-full transition-all ${isMassive ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]' : 'bg-indigo-500'}`} 
                                                        style={{ width: `${Math.max(percentage, 1)}%` }} 
                                                      />
                                                  </div>
                                                  <span className="text-[10px] font-bold text-slate-400 min-w-[35px] text-right">
                                                      {percentage.toFixed(1)}%
                                                  </span>
                                              </div>
                                          </td>
                                          <td className="px-6 py-4 text-right">
                                              <div className="flex flex-col items-end">
                                                  <span className={`font-black text-sm ${isMassive ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-slate-300'}`}>
                                                      {formatBytes(item.sizeBytes)}
                                                  </span>
                                                  {isMassive && (
                                                      <span className="text-[9px] font-bold text-red-500 uppercase tracking-widest mt-0.5 flex items-center gap-1">
                                                          <AlertTriangle className="w-2.5 h-2.5" /> High Usage
                                                      </span>
                                                  )}
                                              </div>
                                          </td>
                                      </tr>
                                  );
                              })}
                              
                              {storageData.length === 0 && !isScanning && (
                                  <tr>
                                      <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground">
                                          No storage cache found. Click "Force Scan Now" to begin.
                                      </td>
                                  </tr>
                              )}
                          </tbody>
                      </table>
                  </div>
              </div>
          </div>
      )}
    </div>
  )
}