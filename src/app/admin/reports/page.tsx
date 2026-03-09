"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, ArrowLeft, AlertTriangle, MessageSquare, CheckCircle2, User, BookOpen, Calendar } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"

export default function AdminReportsPage() {
  // SET PAGE TITLE
  useEffect(() => {
    document.title = "Omnibus - Issues";
  }, []);

  const [reports, setReports] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  
  const [resolveModalOpen, setResolveModalOpen] = useState(false)
  const [selectedReport, setSelectedReport] = useState<any>(null)
  const [adminComment, setAdminComment] = useState("")
  const [resolving, setResolving] = useState(false)
  
  const { toast } = useToast()

  const fetchReports = async () => {
    try {
      const res = await fetch('/api/admin/reports')
      if (res.ok) setReports(await res.json())
    } catch (e) {
      toast({ title: "Failed to load reports", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchReports()
  }, [])

  const handleResolveSubmit = async () => {
    if (!selectedReport) return;
    setResolving(true);
    
    try {
      const res = await fetch('/api/admin/reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            id: selectedReport.id, 
            status: 'CLOSED', 
            adminComment 
        })
      });
      
      if (res.ok) {
        toast({ title: "Report Resolved", description: "The user has been notified." });
        setResolveModalOpen(false);
        setAdminComment("");
        fetchReports();
      } else {
        throw new Error("Failed to update report");
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setResolving(false);
    }
  }

  const openResolveModal = (report: any) => {
    setSelectedReport(report);
    setAdminComment("");
    setResolveModalOpen(true);
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
  }

  const openReports = reports.filter(r => r.status === 'OPEN')
  const closedReports = reports.filter(r => r.status === 'CLOSED')

  return (
    <div className="container mx-auto py-10 px-6 max-w-5xl space-y-8 transition-colors duration-300">
      
      <div className="flex items-center gap-4">
        <Link href="/admin">
          <Button variant="ghost" size="icon" className="hover:bg-muted text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Issue Reports</h1>
      </div>

      <div className="space-y-6">
        <h2 className="text-xl font-bold flex items-center gap-2 border-b border-border pb-2 text-foreground">
            <AlertTriangle className="w-5 h-5 text-red-500" /> Active Reports ({openReports.length})
        </h2>
        
        {openReports.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground border-2 border-dashed rounded-xl border-border bg-muted/30">
                No active issue reports. You're all caught up!
            </div>
        ) : (
            <div className="grid gap-4">
                {openReports.map(report => (
                    <Card key={report.id} className="shadow-sm border-red-200 dark:border-red-900/50 bg-red-50/10 dark:bg-red-900/10">
                        <CardContent className="p-4 sm:p-6 flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                            <div className="space-y-2 flex-1">
                                <div className="flex items-center gap-2">
                                    <h3 className="font-bold text-lg leading-tight text-foreground">{report.series?.name || "Unknown Series"}</h3>
                                    <Badge variant="destructive" className="text-[10px] uppercase font-bold border-none">Needs Review</Badge>
                                </div>
                                <p className="text-sm text-foreground/80 bg-background p-3 rounded border border-border">"{report.description}"</p>
                                <div className="flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-muted-foreground pt-1">
                                    <span className="flex items-center gap-1 font-medium"><User className="w-3 h-3 text-primary" /> Reported by: {report.user?.username || "Unknown"}</span>
                                    <span className="flex items-center gap-1 font-medium"><Calendar className="w-3 h-3" /> {new Date(report.createdAt).toLocaleString()}</span>
                                </div>
                            </div>
                            <div className="flex flex-col gap-2 w-full sm:w-auto shrink-0">
                                <Button asChild variant="outline" className="w-full sm:w-32 border-border hover:bg-muted font-bold transition-colors">
                                  <Link href={`/library/series?path=${encodeURIComponent(report.series?.folderPath)}`}>
                                    <BookOpen className="w-4 h-4 mr-2" /> View Series
                                  </Link>
                                </Button>
                                <Button onClick={() => openResolveModal(report)} className="w-full sm:w-32 bg-green-600 hover:bg-green-700 text-white font-bold shadow-md">
                                  <CheckCircle2 className="w-4 h-4 mr-2" /> Resolve
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        )}
      </div>

      <div className="space-y-6 pt-10">
        <h2 className="text-xl font-bold flex items-center gap-2 border-b border-border pb-2 text-muted-foreground">
            <CheckCircle2 className="w-5 h-5" /> Resolved Reports
        </h2>
        <div className="grid gap-4 opacity-70">
            {closedReports.map(report => (
                <Card key={report.id} className="shadow-none border-border bg-muted/20">
                    <CardContent className="p-4 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <h3 className="font-bold text-sm text-foreground/70">{report.series?.name}</h3>
                            <span className="text-[10px] text-muted-foreground font-mono">{new Date(report.updatedAt).toLocaleDateString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground italic">"{report.description}"</p>
                        {report.adminComment && (
                            <div className="mt-2 bg-muted p-2 rounded text-xs flex gap-2 border border-border">
                                <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
                                <span className="text-foreground/80"><strong>Admin Reply:</strong> {report.adminComment}</span>
                            </div>
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
      </div>

      <Dialog open={resolveModalOpen} onOpenChange={setResolveModalOpen}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border rounded-xl">
            <DialogHeader>
                <DialogTitle className="text-foreground">Resolve Issue Report</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                    Mark this report for <strong className="text-primary">{selectedReport?.series?.name}</strong> as fixed.
                </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="space-y-2">
                    <Label className="text-foreground">Message to User (Optional)</Label>
                    <Textarea 
                        placeholder="e.g. Thanks for letting us know! The files have been re-downloaded." 
                        value={adminComment} 
                        onChange={e => setAdminComment(e.target.value)}
                        className="h-24 bg-background border-border text-foreground focus-visible:ring-primary"
                    />
                    <p className="text-[10px] text-muted-foreground">This message will appear in their notification bell.</p>
                </div>
            </div>
            <DialogFooter>
                <Button variant="outline" className="border-border hover:bg-muted" onClick={() => setResolveModalOpen(false)} disabled={resolving}>Cancel</Button>
                <Button onClick={handleResolveSubmit} disabled={resolving} className="bg-green-600 hover:bg-green-700 text-white font-bold">
                    {resolving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                    Close Issue
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}