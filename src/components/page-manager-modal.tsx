"use client"

// Page Manager (issue #189, Phase 1): an exploded thumbnail view of an issue's pages where an
// admin marks junk pages (scan-group credits and the like) for removal. Takes a QUEUE of issues —
// length 1 from the series page or a single Smart-Matcher card, longer from the matcher's
// multi-select, where it becomes a sequential walker (per-issue confirm, then auto-advance;
// destructive intent never accumulates in client state across issues). The server re-verifies
// every mark against the archive's current page list before rewriting, so a stale grid can only
// abort, never delete the wrong page. CBZ-only in Phase 1 — RAR/7z can't be written back.
import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Loader2, Trash2, AlertTriangle, SkipForward, FileArchive, ScanSearch } from "lucide-react"
import PageSweepModal from "@/components/page-sweep-modal"

export interface PageManagerTarget {
  issueId: string
  filePath: string
  label: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  queue: PageManagerTarget[]
  /** Called when the modal closes after at least one successful removal (refresh page counts etc.). */
  onApplied?: () => void
  /** Pre-marked entry names for the FIRST queue item — the in-reader flagging handoff (issue #189
   *  Phase 2). Intersected with the freshly loaded page list, so stale flags simply drop off. */
  initialMarked?: string[]
}

const CBZ_REGEX = /\.(cbz|zip)$/i

export default function PageManagerModal({ open, onOpenChange, queue, onApplied, initialMarked }: Props) {
  const { toast } = useToast()
  const [idx, setIdx] = useState(0)
  const [pages, setPages] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [marked, setMarked] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [appliedAny, setAppliedAny] = useState(false)
  // Series sweep (issue #189 Phase 3): the tile action hands the page to the sweep modal; a
  // finished sweep bumps refreshKey so this grid reloads (its own pages may have been removed).
  const [sweepEntry, setSweepEntry] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const target = queue[idx]
  const isCbz = !!target && CBZ_REGEX.test(target.filePath)
  const isWalker = queue.length > 1

  // Reset to the first issue whenever the modal (re)opens with a queue.
  useEffect(() => {
    if (!open) return
    setIdx(0)
    setAppliedAny(false)
  }, [open])

  // Load the current issue's page list. Entry NAMES are the unit of work end to end. RAR/7z
  // archives list fine through the engine — removal repacks them as CBZ (note shown in the grid).
  useEffect(() => {
    if (!open || !target) return
    let cancelled = false
    setPages(null)
    setMarked(new Set())
    setLoadError(null)
    setLoading(true)
    fetch(`/api/reader/pages?path=${encodeURIComponent(target.filePath)}`)
      .then(async r => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.error || `Failed to list pages (${r.status})`)
        return data
      })
      .then(data => {
        if (cancelled) return
        if (!Array.isArray(data.pages) || data.pages.length === 0) {
          setLoadError("No readable pages found in this archive.")
        } else {
          setPages(data.pages)
          // The in-reader flagging handoff pre-marks pages on the first queue item only.
          if (idx === 0 && initialMarked && initialMarked.length > 0) {
            const valid = new Set(data.pages as string[])
            setMarked(new Set(initialMarked.filter(n => valid.has(n))))
          }
        }
      })
      .catch(e => { if (!cancelled) setLoadError(e?.message || "Failed to list pages.") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idx, target?.issueId, refreshKey])

  const toggle = (name: string) => {
    setMarked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const advance = () => {
    if (idx + 1 < queue.length) {
      setIdx(idx + 1)
    } else {
      onOpenChange(false)
      if (appliedAny) onApplied?.()
    }
  }

  const closeModal = (openState: boolean) => {
    if (!openState && appliedAny) onApplied?.()
    onOpenChange(openState)
  }

  const applyRemoval = async () => {
    if (!target || marked.size === 0) return
    setApplying(true)
    try {
      const res = await fetch('/api/library/issue/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId: target.issueId, entryNames: [...marked] }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Removal failed (${res.status})`)
      setAppliedAny(true)
      toast({
        title: "Pages removed",
        description: `${data.removed} page(s) deleted from ${target.label} — ${data.newPageCount} page(s) remain.${data.convertedToCbz ? ' The file was repacked as CBZ.' : ''} Progress and bookmarks were adjusted.`,
      })
      setConfirmOpen(false)
      advance()
    } catch (e: any) {
      setConfirmOpen(false)
      toast({ title: "Page removal failed", description: e?.message || "Unknown error", variant: "destructive" })
    } finally {
      setApplying(false)
    }
  }

  const allMarked = pages !== null && marked.size >= pages.length

  return (
    <>
      <Dialog open={open} onOpenChange={closeModal}>
        <DialogContent className="sm:max-w-[860px] max-h-[90vh] flex flex-col bg-background border-border rounded-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              Manage Pages{target ? ` — ${target.label}` : ''}
              {isWalker && <Badge variant="secondary">Issue {idx + 1} of {queue.length}</Badge>}
            </DialogTitle>
            <DialogDescription>
              Click the pages to remove (scan credits, banners, junk). The archive is rewritten without them — this cannot be undone. Reading progress and bookmarks are adjusted automatically.
            </DialogDescription>
          </DialogHeader>

          {!target ? null : loading ? (
            <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading pages…
            </div>
          ) : loadError ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-500" />
              <p className="font-semibold text-foreground">Couldn't load this archive's pages</p>
              <p className="text-sm text-muted-foreground max-w-md">{loadError}</p>
            </div>
          ) : pages ? (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              {!isCbz && (
                <div className="flex items-start gap-2 p-3 mt-1 rounded border border-amber-500/40 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
                  <FileArchive className="w-4 h-4 shrink-0 mt-px" />
                  <span>Removing pages rewrites this file as <strong>CBZ</strong> — RAR/7z archives can't be written back. Reading continues seamlessly afterward.</span>
                </div>
              )}
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 py-2">
                {pages.map((name, i) => {
                  const isMarked = marked.has(name)
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggle(name)}
                      title={name}
                      className={`relative rounded-lg border-2 overflow-hidden text-left transition-all focus:outline-none focus:ring-2 focus:ring-primary ${isMarked ? 'border-red-500 ring-1 ring-red-500/50' : 'border-border hover:border-primary/60'}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/reader/image?path=${encodeURIComponent(target.filePath)}&page=${encodeURIComponent(name)}`}
                        alt={`Page ${i + 1}`}
                        loading="lazy"
                        className={`w-full aspect-[2/3] object-cover bg-muted transition-opacity ${isMarked ? 'opacity-40' : ''}`}
                      />
                      <span className="absolute top-1 left-1 text-[10px] font-bold bg-black/60 text-white px-1.5 py-0.5 rounded">{i + 1}</span>
                      {isMarked && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <span className="bg-red-600 text-white rounded-full p-2"><Trash2 className="w-4 h-4" /></span>
                        </span>
                      )}
                      <span
                        role="button"
                        tabIndex={0}
                        title="Remove this page everywhere in the series"
                        onClick={(e) => { e.stopPropagation(); setSweepEntry(name) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setSweepEntry(name) } }}
                        className="absolute bottom-1 right-1 p-1.5 rounded bg-black/60 text-white hover:bg-primary transition-colors"
                      >
                        <ScanSearch className="w-3.5 h-3.5" />
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          <DialogFooter className="shrink-0 flex-col sm:flex-row gap-2 sm:items-center">
            {pages && (
              <span className="text-xs text-muted-foreground sm:mr-auto">
                {marked.size} of {pages.length} page{pages.length !== 1 ? 's' : ''} marked
                {allMarked ? ' — at least one page must remain' : ''}
              </span>
            )}
            <Button variant="outline" onClick={() => closeModal(false)} className="border-border hover:bg-muted">Close</Button>
            {isWalker && (
              <Button variant="outline" onClick={advance} disabled={applying} className="border-border hover:bg-muted">
                <SkipForward className="w-4 h-4 mr-2" /> {idx + 1 < queue.length ? 'Skip to Next' : 'Finish'}
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={!pages || marked.size === 0 || allMarked || applying}
              onClick={() => setConfirmOpen(true)}
              className="font-bold"
            >
              {applying ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Delete {marked.size > 0 ? marked.size : ''} Page{marked.size !== 1 ? 's' : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={applyRemoval}
        title="Delete these pages?"
        description={`Delete ${marked.size} page${marked.size !== 1 ? 's' : ''} from ${target?.label ?? 'this issue'}? The archive is rewritten without them. This cannot be undone.`}
        confirmText="Delete Pages"
        variant="destructive"
        isLoading={applying}
      />

      {target && (
        <PageSweepModal
          open={!!sweepEntry}
          onOpenChange={(o) => { if (!o) setSweepEntry(null) }}
          source={sweepEntry ? { issueId: target.issueId, filePath: target.filePath, label: target.label, entryName: sweepEntry } : null}
          onApplied={() => { setAppliedAny(true); setRefreshKey(k => k + 1) }}
        />
      )}
    </>
  )
}
