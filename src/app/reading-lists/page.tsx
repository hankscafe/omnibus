"use client"

import { useState, useEffect, Suspense } from "react"
import { useSession } from "next-auth/react"
import { useSearchParams } from "next/navigation"
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { 
    BookOpen, Trash2, Plus, GripVertical, Loader2, Image as ImageIcon, 
    ArrowLeft, ListOrdered, Calendar, Minus, FolderOpen, CloudDownload,
    Check, DownloadCloud, Sparkles, Globe, ExternalLink
} from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"

function ReadingListsContent() {
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'ADMIN'
  const searchParams = useSearchParams()
  const paramId = searchParams.get('id')
  const { toast } = useToast()
  
  const [lists, setLists] = useState<any[]>([])
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  
  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newListName, setNewListName] = useState("")
  const [newListDesc, setNewListDesc] = useState("")
  const [isGlobal, setIsGlobal] = useState(false) 
  const [isCreating, setIsCreating] = useState(false)

  // Auto-Build Modal
  const [autoBuildModalOpen, setAutoBuildModalOpen] = useState(false)
  const [cvEventId, setCvEventId] = useState("")
  const [autoBuildGlobal, setAutoBuildGlobal] = useState(false) 
  const [isAutoBuilding, setIsAutoBuilding] = useState(false)

  // Deletion Modal
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Requests Tracking
  const [requestingIds, setRequestingIds] = useState<Set<string>>(new Set())
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set())
  const [isBulkDownloading, setIsBulkDownloading] = useState(false)

  // Fix for Next.js hydration mismatch
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
    fetchLists(paramId)

    // Restore requested state from storage
    const savedRequests = localStorage.getItem('omnibus_requested_issues');
    if (savedRequests) {
        try { setRequestedIds(new Set(JSON.parse(savedRequests))); } catch (e) {}
    }
  }, [paramId])

  const fetchLists = async (selectId?: string | null) => {
    try {
      const res = await fetch(`/api/reading-lists?t=${Date.now()}`)
      if (res.ok) {
        const data = await res.json()
        setLists(data)
        if (selectId && data.find((l:any) => l.id === selectId)) {
            setActiveListId(selectId)
        } else if (data.length > 0 && !activeListId) {
            setActiveListId(data[0].id)
        } else if (data.length === 0) {
            setActiveListId(null)
        }
      }
    } catch (e) {
      toast({ title: "Error", description: "Failed to load reading lists.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const handleCreateList = async () => {
    if (!newListName.trim()) return;
    setIsCreating(true);
    try {
        const res = await fetch('/api/reading-lists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newListName, description: newListDesc, isGlobal })
        });
        if (res.ok) {
            toast({ title: "List Created" });
            setCreateModalOpen(false);
            setNewListName("");
            setNewListDesc("");
            setIsGlobal(false);
            fetchLists();
        }
    } catch (e) {
        toast({ title: "Error", variant: "destructive" });
    } finally {
        setIsCreating(false);
    }
  }

  const handleAutoBuild = async () => {
      if (!cvEventId.trim()) return;
      setIsAutoBuilding(true);
      try {
          const res = await fetch('/api/reading-lists/auto-build', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cvEventId: parseInt(cvEventId), isGlobal: autoBuildGlobal })
          });
          const data = await res.json();
          if (res.ok) {
              toast({ title: "Event Auto-Built!", description: data.message });
              setAutoBuildModalOpen(false);
              setCvEventId("");
              setAutoBuildGlobal(false);
              fetchLists(data.listId);
          } else {
              throw new Error(data.error);
          }
      } catch (e: any) {
          toast({ title: "Auto-Build Failed", description: e.message, variant: "destructive" });
      } finally {
          setIsAutoBuilding(false);
      }
  }

  const confirmDeleteList = async () => {
    if (!activeListId) return;
    setIsDeleting(true);
    try {
        const res = await fetch(`/api/reading-lists?id=${activeListId}`, { method: 'DELETE' });
        if (res.ok) {
            toast({ title: "List Deleted" });
            setActiveListId(null);
            setDeleteModalOpen(false);
            fetchLists();
        }
    } catch (e) {
        toast({ title: "Error", variant: "destructive" });
    } finally {
        setIsDeleting(false);
    }
  }

  const handleRemoveItem = async (issueId: string) => {
      if (!activeListId) return;
      try {
          const res = await fetch('/api/reading-lists/items', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ listId: activeListId, issueId, action: 'remove' })
          });
          if (res.ok) fetchLists(activeListId);
      } catch (e) {
          toast({ title: "Error", variant: "destructive" });
      }
  }

  const handleRequestMissing = async (item: any, coverUrl: string | null = null) => {
      if (!item.cvIssueId) return false;
      setRequestingIds(prev => new Set(prev).add(item.id));
      
      try {
          let volumeId = 0;
          let year = new Date().getFullYear().toString();
          
          try {
              const lookupRes = await fetch(`/api/reading-lists/lookup-volume?issueId=${item.cvIssueId}`);
              if (lookupRes.ok) {
                  const data = await lookupRes.json();
                  if (data.volumeId) volumeId = data.volumeId;
                  if (data.year) year = data.year;
              }
          } catch (e) { console.error("Lookup failed", e); }

          const standardRes = await fetch('/api/request', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  type: 'issue',
                  cvId: volumeId,
                  name: item.title, 
                  year: year,
                  publisher: "Unknown",
                  image: coverUrl
              })
          });

          if (!standardRes.ok) {
              const baseName = item.title.split('#')[0].trim();
              const cleanSearchTerm = baseName.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "+");
              const searchLink = `https://getcomics.org/?s=${cleanSearchTerm}`;

              const fallbackRes = await fetch('/api/reading-lists/manual-fallback', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      cvId: volumeId,
                      name: item.title,
                      image: coverUrl,
                      searchLink: searchLink
                  })
              });

              if (!fallbackRes.ok) throw new Error("Fallback failed");
          }

          setRequestedIds(prev => {
              const next = new Set(prev).add(item.id);
              localStorage.setItem('omnibus_requested_issues', JSON.stringify(Array.from(next)));
              return next;
          });
          return true;
          
      } catch (error: any) {
          return false;
      } finally {
          setRequestingIds(prev => {
              const next = new Set(prev);
              next.delete(item.id);
              return next;
          });
      }
  }

  const handleDownloadAllMissing = async (missingItems: any[]) => {
      if (missingItems.length === 0) return;
      setIsBulkDownloading(true);
      toast({ title: "Bulk Request Started", description: `Queuing ${missingItems.length} issues...` });
      
      let successCount = 0;
      for (const item of missingItems) {
          if (!requestedIds.has(item.id)) {
              const coverUrl = activeList?.coverUrl || null; 
              const success = await handleRequestMissing(item, coverUrl);
              if (success) successCount++;
              await new Promise(resolve => setTimeout(resolve, 300));
          }
      }
      toast({ title: "Bulk Request Complete", description: `Queued ${successCount} issues.` });
      setIsBulkDownloading(false);
  }

  const onDragEnd = async (result: any) => {
      if (!result.destination || !activeListId) return;
      
      const activeListIndex = lists.findIndex(l => l.id === activeListId);
      if (activeListIndex === -1) return;

      const newLists = [...lists];
      const items = Array.from(newLists[activeListIndex].items);
      const [reorderedItem] = items.splice(result.source.index, 1);
      items.splice(result.destination.index, 0, reorderedItem);

      newLists[activeListIndex].items = items;
      setLists(newLists);

      const updatedOrder = items.map((item: any, index: number) => ({
          id: item.id,
          order: index
      }));

      try {
          await fetch('/api/reading-lists/items', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ listId: activeListId, items: updatedOrder })
          });
      } catch (e) {
          toast({ title: "Failed to save order", variant: "destructive" });
          fetchLists(activeListId); 
      }
  }

  if (!isMounted || loading) {
      return (
          <div className="flex justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
      );
  }

  const activeList = lists.find(l => l.id === activeListId);
  const missingItems = activeList ? activeList.items.filter((i: any) => !i.issueId) : [];

  return (
    <div className="container mx-auto py-10 px-6 max-w-6xl space-y-8 transition-colors duration-300">
      
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" asChild className="shrink-0 text-foreground hover:bg-muted"><Link href="/profile"><ArrowLeft className="w-5 h-5" /></Link></Button>
            <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">
                <ListOrdered className="w-7 h-7 text-primary" />
                Reading Lists
            </h1>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-8 items-start">
          <div className="space-y-4">
              <div className="flex flex-col gap-2">
                  <Button className="w-full font-bold shadow-md bg-primary hover:bg-primary/90 text-primary-foreground border-0" onClick={() => setAutoBuildModalOpen(true)}>
                      <Sparkles className="w-4 h-4 mr-2" /> Auto-Build Story Arc
                  </Button>
                  <Button variant="outline" className="w-full font-bold shadow-sm border-border hover:bg-muted" onClick={() => setCreateModalOpen(true)}>
                      <Plus className="w-4 h-4 mr-2" /> Create Empty List
                  </Button>
                  <Button variant="outline" className="w-full border-border font-bold hover:bg-muted text-foreground" asChild>
                      <a href="https://comicvine.gamespot.com/story-arcs/" target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-4 h-4 mr-2" /> Lookup Arc IDs
                      </a>
                  </Button>
              </div>

              <Card className="shadow-sm border-border bg-background">
                  <div className="p-2 flex flex-col gap-1">
                      {lists.length === 0 ? (
                          <div className="p-4 text-center text-sm text-muted-foreground italic">No reading lists created yet.</div>
                      ) : (
                          lists.map(list => (
                              <div 
                                  key={list.id} 
                                  onClick={() => setActiveListId(list.id)}
                                  className={`px-3 py-2.5 rounded-md flex items-center justify-between cursor-pointer transition-all ${
                                      activeListId === list.id 
                                      ? 'bg-primary/10 border border-primary/30 shadow-sm' 
                                      : 'border border-transparent hover:bg-muted/50'
                                  }`}
                              >
                                  <div className="min-w-0 pr-2">
                                      <div className="flex items-center gap-2">
                                          <h3 className={`font-bold truncate text-sm ${activeListId === list.id ? 'text-primary' : 'text-foreground'}`}>{list.name}</h3>
                                          {!list.userId && <Globe className="w-3 h-3 text-emerald-500 shrink-0" title="Global List" />}
                                      </div>
                                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">{list.items.length} Issues</p>
                                  </div>
                              </div>
                          ))
                      )}
                  </div>
              </Card>
          </div>

          {activeList ? (
              <div className="space-y-6">
                  <Card className="shadow-sm border-primary/20 bg-primary/5">
                      <CardHeader className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                          <div>
                              <div className="flex items-center gap-2">
                                <CardTitle className="text-2xl font-black text-primary">{activeList.name}</CardTitle>
                                {!activeList.userId && <Badge variant="outline" className="bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800"><Globe className="w-3 h-3 mr-1"/> Global</Badge>}
                              </div>
                              {activeList.description && <CardDescription className="mt-2 text-primary/80 max-w-2xl">{activeList.description}</CardDescription>}
                          </div>
                          <div className="flex gap-2 shrink-0">
                              {missingItems.length > 0 && (
                                  <Button 
                                      size="sm" 
                                      variant="outline" 
                                      className="font-bold border-primary/30 text-primary bg-background hover:bg-primary/10"
                                      disabled={isBulkDownloading}
                                      onClick={() => handleDownloadAllMissing(missingItems)}
                                  >
                                      {isBulkDownloading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DownloadCloud className="w-4 h-4 mr-2" />}
                                      Missing ({missingItems.length})
                                  </Button>
                              )}
                              {(isAdmin || activeList.userId === session?.user?.id) && (
                                  <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => setDeleteModalOpen(true)}>
                                      <Trash2 className="w-4 h-4" />
                                  </Button>
                              )}
                          </div>
                      </CardHeader>
                  </Card>

                  {activeList.items.length === 0 ? (
                      <div className="text-center py-20 border-2 border-dashed rounded-xl border-border bg-muted/30">
                          <BookOpen className="w-12 h-12 mx-auto text-muted-foreground/50 mb-3" />
                          <h3 className="text-lg font-bold text-foreground">This list is empty</h3>
                          <p className="text-sm text-muted-foreground mt-1">Navigate to any series and use the "Add to List" button on an issue.</p>
                      </div>
                  ) : (
                      <DragDropContext onDragEnd={onDragEnd}>
                          <Droppable droppableId="reading-list">
                              {(provided) => (
                                  <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-3 pb-20">
                                      {activeList.items.map((item: any, index: number) => {
                                          const issue = item.issue;
                                          const series = issue?.series;
                                          const coverUrl = activeList.coverUrl || issue?.coverUrl || (series?.folderPath ? `/api/library/cover?path=${encodeURIComponent(series.folderPath)}` : null);

                                          if (!issue) {
                                              const isRequesting = requestingIds.has(item.id);
                                              const isAlreadyRequested = requestedIds.has(item.id);
                                              
                                              return (
                                                  <Draggable key={item.id} draggableId={item.id} index={index}>
                                                      {(provided, snapshot) => (
                                                          <div 
                                                              ref={provided.innerRef} 
                                                              {...provided.draggableProps} 
                                                              className={`flex items-center gap-4 p-3 bg-muted/50 border border-dashed rounded-xl opacity-80 transition-all ${snapshot.isDragging ? 'shadow-xl scale-[1.02] border-primary z-50 bg-background' : 'border-border'}`}
                                                          >
                                                              <div {...provided.dragHandleProps} className="px-2 py-4 text-muted-foreground hover:text-primary cursor-grab active:cursor-grabbing">
                                                                  <GripVertical className="w-5 h-5" />
                                                              </div>
                                                              
                                                              <div className="w-12 h-16 shrink-0 rounded overflow-hidden bg-muted border border-border flex items-center justify-center grayscale">
                                                                  {coverUrl ? <img src={coverUrl} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-5 h-5 text-muted-foreground/50" />}
                                                              </div>

                                                              <div className="flex-1 min-w-0">
                                                                  <div className="flex items-center gap-2 mb-1">
                                                                      <Badge variant="secondary" className="text-[10px] font-mono h-5 bg-muted border-border text-muted-foreground">Part {index + 1}</Badge>
                                                                      <h4 className="font-bold text-sm truncate text-muted-foreground">{item.title}</h4>
                                                                  </div>
                                                                  <div className="text-[10px] font-bold uppercase tracking-wider text-orange-500 dark:text-orange-400 mt-1">Not in Library</div>
                                                              </div>

                                                              <div className="flex items-center gap-2 shrink-0 pr-2">
                                                                  {isAlreadyRequested ? (
                                                                      <Button size="sm" variant="secondary" disabled className="h-8 bg-green-50 text-green-700 dark:bg-green-900/20 border-green-200 opacity-100 cursor-not-allowed">
                                                                          <Check className="w-3.5 h-3.5 mr-1"/> Requested
                                                                      </Button>
                                                                  ) : (
                                                                      <Button size="sm" variant="outline" className="h-8 font-bold text-[10px] uppercase border-border hover:bg-muted tracking-wider" onClick={() => handleRequestMissing(item, coverUrl)} disabled={isRequesting}>
                                                                          {isRequesting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1"/> : <CloudDownload className="w-3.5 h-3.5 mr-1"/>} Request
                                                                      </Button>
                                                                  )}
                                                              </div>
                                                          </div>
                                                      )}
                                                  </Draggable>
                                              );
                                          }

                                          return (
                                              <Draggable key={item.id} draggableId={item.id} index={index}>
                                                  {(provided, snapshot) => (
                                                      <div 
                                                          ref={provided.innerRef} 
                                                          {...provided.draggableProps} 
                                                          className={`flex items-center gap-4 p-3 bg-background border border-border rounded-xl shadow-sm transition-all ${snapshot.isDragging ? 'shadow-xl scale-[1.02] border-primary z-50 ring-2 ring-primary/20' : 'hover:border-primary/50'}`}
                                                      >
                                                          <div {...provided.dragHandleProps} className="px-2 py-4 text-muted-foreground hover:text-primary cursor-grab active:cursor-grabbing">
                                                              <GripVertical className="w-5 h-5" />
                                                          </div>
                                                          
                                                          <div className="w-12 h-16 shrink-0 rounded overflow-hidden bg-muted border border-border flex items-center justify-center">
                                                              {coverUrl ? <img src={coverUrl} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-5 h-5 text-muted-foreground/50" />}
                                                          </div>

                                                          <div className="flex-1 min-w-0">
                                                              <div className="flex items-center gap-2 mb-1">
                                                                  <Badge variant="secondary" className="text-[10px] font-mono h-5 bg-primary/20 text-primary border-primary/30">Part {index + 1}</Badge>
                                                                  <h4 className="font-bold text-sm truncate text-foreground">{series.name}</h4>
                                                              </div>
                                                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                                  <span className="font-bold text-foreground">Issue #{issue.number}</span>
                                                                  <span className="truncate hidden sm:inline">• {issue.name || "Untitled Issue"}</span>
                                                              </div>
                                                          </div>

                                                          <div className="flex items-center gap-2 shrink-0 pr-2">
                                                              <Button variant="outline" size="sm" asChild className="h-8 shadow-sm border-border hover:bg-muted">
                                                                  <Link href={`/reader?path=${encodeURIComponent(issue.filePath)}&series=${encodeURIComponent(series.folderPath)}`}>
                                                                      <BookOpen className="w-3.5 h-3.5 sm:mr-2" /> <span className="hidden sm:inline">Read</span>
                                                                  </Link>
                                                              </Button>
                                                              {(isAdmin || activeList.userId === session?.user?.id) && (
                                                                  <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 hidden sm:flex" onClick={() => handleRemoveItem(issue.id)}>
                                                                      <Minus className="w-4 h-4" />
                                                                  </Button>
                                                              )}
                                                          </div>
                                                      </div>
                                                  )}
                                              </Draggable>
                                          );
                                      })}
                                      {provided.placeholder}
                                  </div>
                              )}
                          </Droppable>
                      </DragDropContext>
                  )}
              </div>
          ) : (
              <div className="hidden lg:flex flex-col items-center justify-center py-32 text-center border-2 border-dashed rounded-xl border-border bg-background">
                  <FolderOpen className="w-16 h-16 text-muted-foreground/30 mb-4" />
                  <p className="text-lg font-bold text-muted-foreground">Select a reading list to manage.</p>
              </div>
          )}
      </div>

      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-[425px] bg-background border-border rounded-xl">
            <DialogHeader><DialogTitle>Create Reading Order</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label>Story Arc / List Name</Label>
                    <Input placeholder="e.g. My Favorite Batman Issues" value={newListName} onChange={e => setNewListName(e.target.value)} className="bg-background border-border" />
                </div>
                <div className="grid gap-2">
                    <Label>Description (Optional)</Label>
                    <Input placeholder="e.g. A custom list of great stories." value={newListDesc} onChange={e => setNewListDesc(e.target.value)} className="bg-background border-border" />
                </div>
                {isAdmin && (
                    <div className="flex items-center gap-3 mt-2 p-3 bg-muted border border-border rounded-lg">
                        <Switch id="global-toggle" checked={isGlobal} onCheckedChange={setIsGlobal} />
                        <div className="grid gap-0.5">
                            <Label htmlFor="global-toggle" className="font-bold cursor-pointer">Make public for all users</Label>
                            <p className="text-[10px] text-muted-foreground">Global lists appear on every user's profile.</p>
                        </div>
                    </div>
                )}
            </div>
            <DialogFooter>
                <Button variant="outline" onClick={() => setCreateModalOpen(false)} className="border-border hover:bg-muted">Cancel</Button>
                <Button onClick={handleCreateList} disabled={isCreating || !newListName.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                    {isCreating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Create List"}
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={autoBuildModalOpen} onOpenChange={setAutoBuildModalOpen}>
        <DialogContent className="sm:max-w-[450px] bg-background border-border rounded-xl">
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-primary">
                    <Sparkles className="w-5 h-5" /> Auto-Build Story Arc
                </DialogTitle>
                <DialogDescription>
                    Omnibus will scrape ComicVine, build the entire official reading order, and map your downloaded files directly into the list!
                </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label className="font-bold">ComicVine Story Arc ID</Label>
                    <Input 
                        placeholder="e.g. 40615" 
                        value={cvEventId} 
                        onChange={e => setCvEventId(e.target.value)} 
                        className="bg-background border-border font-mono text-lg" 
                    />
                    <p className="text-[11px] text-muted-foreground">Find the ID in the URL of the event on ComicVine (e.g. /marvel-civil-war/4045-<b>40615</b>/)</p>
                </div>

                {isAdmin && (
                    <div className="flex items-center gap-3 mt-2 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                        <Switch id="auto-global-toggle" checked={autoBuildGlobal} onCheckedChange={setAutoBuildGlobal} />
                        <div className="grid gap-0.5">
                            <Label htmlFor="auto-global-toggle" className="font-bold cursor-pointer">Make story arc public</Label>
                            <p className="text-[10px] text-muted-foreground">This reading order will be available to all users.</p>
                        </div>
                    </div>
                )}
                
                <div className="space-y-2 mt-4 pt-4 border-t border-border">
                    <Label className="text-xs uppercase tracking-widest text-muted-foreground font-black">Quick Load Popular Story Arcs</Label>
                    <div className="flex flex-wrap gap-2">
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted border-border text-foreground" onClick={() => setCvEventId("40615")}>Marvel Civil War</Badge>
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted border-border text-foreground" onClick={() => setCvEventId("40978")}>Secret Wars (1984)</Badge>
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted border-border text-foreground" onClick={() => setCvEventId("42711")}>Infinity Gauntlet</Badge>
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted border-border text-foreground" onClick={() => setCvEventId("56053")}>Flashpoint</Badge>
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted border-border text-foreground" onClick={() => setCvEventId("56681")}>Avengers vs X-Men</Badge>
                        <Badge variant="outline" className="cursor-pointer hover:bg-muted border-border text-foreground" onClick={() => setCvEventId("40411")}>Crisis on Infinite Earths</Badge>
                    </div>
                </div>
            </div>
            <DialogFooter>
                <Button variant="outline" onClick={() => setAutoBuildModalOpen(false)} className="border-border hover:bg-muted">Cancel</Button>
                <Button onClick={handleAutoBuild} disabled={isAutoBuilding || !cvEventId.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                    {isAutoBuilding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Build List"}
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog 
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={confirmDeleteList}
        isLoading={isDeleting}
        title="Delete Reading List?"
        description={`Are you sure you want to delete the "${activeList?.name}" reading list? This action cannot be undone.`}
        confirmText="Delete List"
      />
    </div>
  )
}

// Add this at the absolute bottom
export default function ReadingListsPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-muted-foreground">Loading...</div>}>
      <ReadingListsContent />
    </Suspense>
  )
}