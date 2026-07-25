"use client"

// Series page sweep (issue #189 Phase 3, "the One Piece button"): from one flagged page, find
// every byte-identical copy across the series and remove them in one background run. Three
// phases: SCAN (client walks the series in batches so progress is real and no request runs
// long), REVIEW (every match visible with its thumbnail, all pre-checked, one explicit confirm),
// RUN (a BullMQ job chews through files server-side — safe to close this window; progress is
// polled from the server and the admin bell announces completion). Cancel stops cooperatively on
// a file boundary, so a half-modified archive can never exist.
import { useState, useEffect, useRef } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Loader2, Trash2, AlertTriangle, ScanSearch, XCircle, CheckCircle2, FileArchive } from "lucide-react"

export interface PageSweepSource {
  issueId: string
  filePath: string
  label: string
  entryName: string
}

interface SweepMatch {
  issueId: string
  label: string
  filePath: string
  entryName: string
  index: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: PageSweepSource | null
  /** Called when a finished run removed at least one page (refresh page lists/counts). */
  onApplied?: () => void
}

const SCAN_BATCH = 25
const POLL_MS = 4000

type Phase = 'scanning' | 'review' | 'running' | 'done' | 'error'

export default function PageSweepModal({ open, onOpenChange, source, onApplied }: Props) {
  const { toast } = useToast()
  const [phase, setPhase] = useState<Phase>('scanning')
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 })
  const [matches, setMatches] = useState<SweepMatch[]>([])
  const [skipped, setSkipped] = useState<{ label: string; reason: string }[]>([])
  const [scanErrors, setScanErrors] = useState<{ label: string; error: string }[]>([])
  const [deselected, setDeselected] = useState<Set<string>>(new Set()) // keyed issueId_entryName
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [enqueuing, setEnqueuing] = useState(false)
  const [run, setRun] = useState<any>(null) // last polled sweep result
  const [cancelling, setCancelling] = useState(false)
  const runIdRef = useRef<string | null>(null)
  const notifiedDone = useRef(false)

  const key = (m: SweepMatch) => `${m.issueId}_${m.entryName}`
  const selectedMatches = matches.filter(m => !deselected.has(key(m)))
  const selectedFiles = new Set(selectedMatches.map(m => m.issueId)).size

  // SCAN: candidates, then batched engine scans. Cancelled cleanly if the dialog closes mid-walk.
  useEffect(() => {
    if (!open || !source) return
    let cancelled = false
    setPhase('scanning')
    setMatches([])
    setSkipped([])
    setScanErrors([])
    setDeselected(new Set())
    setError(null)
    setRun(null)
    runIdRef.current = null
    notifiedDone.current = false

    const scan = async () => {
      try {
        const candRes = await fetch(`/api/library/issue/pages/sweep/candidates?issueId=${encodeURIComponent(source.issueId)}`)
        const candData = await candRes.json().catch(() => ({}))
        if (!candRes.ok) throw new Error(candData?.error || `Failed to list the series (${candRes.status})`)
        const candidates: { issueId: string; label: string }[] = candData.candidates || []
        setScanProgress({ scanned: 0, total: candidates.length })
        const labelById = new Map(candidates.map(c => [c.issueId, c.label]))

        for (let i = 0; i < candidates.length; i += SCAN_BATCH) {
          if (cancelled) return
          const batch = candidates.slice(i, i + SCAN_BATCH)
          const res = await fetch('/api/library/issue/pages/sweep/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceIssueId: source.issueId,
              sourceEntry: source.entryName,
              candidateIssueIds: batch.map(b => b.issueId),
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data?.error || `Scan failed (${res.status})`)
          if (cancelled) return
          setMatches(prev => [...prev, ...(data.matches || [])])
          setSkipped(prev => [...prev, ...(data.skipped || []).map((s: any) => ({ label: s.label || labelById.get(s.issueId) || s.issueId, reason: s.reason }))])
          setScanErrors(prev => [...prev, ...(data.errors || []).map((e: any) => ({ label: e.label || labelById.get(e.issueId) || e.issueId, error: e.error }))])
          setScanProgress({ scanned: Math.min(i + batch.length, candidates.length), total: candidates.length })
        }
        if (!cancelled) setPhase('review')
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || 'Scan failed.'); setPhase('error') }
      }
    }
    scan()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.issueId, source?.entryName])

  // RUN: poll the server-side result while the dialog shows the running phase.
  useEffect(() => {
    if (!open || phase !== 'running') return
    let stopped = false
    const poll = async () => {
      try {
        const res = await fetch('/api/library/issue/pages/sweep', { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (stopped) return
        const result = data?.result
        if (result && result.runId === runIdRef.current) {
          setRun(result)
          if (result.status === 'COMPLETED' || result.status === 'CANCELLED') {
            setPhase('done')
            if (!notifiedDone.current) {
              notifiedDone.current = true
              if (result.removed > 0) onApplied?.()
            }
          }
        }
      } catch { /* transient poll failure — keep trying */ }
    }
    poll()
    const t = setInterval(poll, POLL_MS)
    return () => { stopped = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase])

  const startSweep = async () => {
    if (!source || selectedMatches.length === 0) return
    setEnqueuing(true)
    try {
      const res = await fetch('/api/library/issue/pages/sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceIssueId: source.issueId,
          sourceEntry: source.entryName,
          items: selectedMatches.map(m => ({ issueId: m.issueId, entryName: m.entryName })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `Failed to start the sweep (${res.status})`)
      runIdRef.current = data.runId
      setConfirmOpen(false)
      setPhase('running')
      toast({ title: "Page sweep started", description: `${data.total} file(s) queued — it runs in the background, safe to close this window.` })
    } catch (e: any) {
      setConfirmOpen(false)
      toast({ title: "Couldn't start the sweep", description: e?.message || 'Unknown error', variant: "destructive" })
    } finally {
      setEnqueuing(false)
    }
  }

  const cancelSweep = async () => {
    if (!runIdRef.current) return
    setCancelling(true)
    try {
      await fetch('/api/library/issue/pages/sweep/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: runIdRef.current }),
      })
      toast({ title: "Cancelling", description: "The sweep stops after the file it's currently on." })
    } finally {
      setCancelling(false)
    }
  }

  const progressPct = run?.total ? Math.round((run.processed / run.total) * 100) : 0

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[680px] max-h-[90vh] flex flex-col bg-background border-border rounded-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <ScanSearch className="w-5 h-5 text-primary" /> Remove This Page Everywhere
            </DialogTitle>
            <DialogDescription>
              Finds byte-identical copies of this page across the whole series and removes them in one background run. Matching is by content, so renamed copies are found too.
            </DialogDescription>
          </DialogHeader>

          {source && (
            <div className="shrink-0 flex items-center gap-3 p-2 rounded-lg border border-border bg-muted/30">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/reader/image?path=${encodeURIComponent(source.filePath)}&page=${encodeURIComponent(source.entryName)}`}
                alt="Source page" className="w-12 aspect-[2/3] object-cover rounded bg-muted"
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{source.label}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{source.entryName}</p>
              </div>
            </div>
          )}

          {phase === 'scanning' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 py-10">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Scanning the series… {scanProgress.scanned} of {scanProgress.total} file{scanProgress.total !== 1 ? 's' : ''}
              </p>
              {matches.length > 0 && <p className="text-xs text-muted-foreground">{matches.length} match{matches.length !== 1 ? 'es' : ''} so far</p>}
            </div>
          )}

          {phase === 'error' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-500" />
              <p className="font-semibold text-foreground">The scan didn't finish</p>
              <p className="text-sm text-muted-foreground max-w-md">{error}</p>
            </div>
          )}

          {phase === 'review' && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3 py-1">
              <p className="text-sm font-semibold text-foreground">
                {matches.length === 0
                  ? 'No identical copies found in this series.'
                  : `${matches.length} cop${matches.length !== 1 ? 'ies' : 'y'} found across ${new Set(matches.map(m => m.issueId)).size} file(s) — uncheck any to keep.`}
              </p>
              <div className="space-y-1.5">
                {matches.map(m => {
                  const k = key(m)
                  const checked = !deselected.has(k)
                  return (
                    <label key={k} className={`flex items-center gap-3 p-2 rounded border cursor-pointer transition-colors ${checked ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-background'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setDeselected(prev => {
                          const next = new Set(prev)
                          if (next.has(k)) next.delete(k)
                          else next.add(k)
                          return next
                        })}
                        className="accent-red-600 shrink-0"
                      />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/reader/image?path=${encodeURIComponent(m.filePath)}&page=${encodeURIComponent(m.entryName)}`}
                        alt="" loading="lazy" className="w-9 aspect-[2/3] object-cover rounded bg-muted shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground truncate">{m.label}</p>
                        <p className="text-xs text-muted-foreground truncate">Page {m.index + 1} · <span className="font-mono">{m.entryName}</span></p>
                      </div>
                    </label>
                  )
                })}
              </div>
              {skipped.length > 0 && (
                <div className="flex items-start gap-2 p-3 rounded border border-amber-500/40 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
                  <FileArchive className="w-4 h-4 shrink-0 mt-px" />
                  <span>{skipped.length} file{skipped.length !== 1 ? 's' : ''} skipped (not CBZ — convert first, then re-run the sweep): {skipped.slice(0, 6).map(s => s.label).join(', ')}{skipped.length > 6 ? ` +${skipped.length - 6} more` : ''}</span>
                </div>
              )}
              {scanErrors.length > 0 && (
                <div className="flex items-start gap-2 p-3 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-500">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span>{scanErrors.length} file{scanErrors.length !== 1 ? 's' : ''} couldn't be scanned: {scanErrors.slice(0, 4).map(e => e.label).join(', ')}{scanErrors.length > 4 ? ` +${scanErrors.length - 4} more` : ''}</span>
                </div>
              )}
            </div>
          )}

          {(phase === 'running' || phase === 'done') && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3 py-2">
              <div className="flex items-center gap-2">
                {phase === 'running'
                  ? <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
                  : run?.status === 'COMPLETED'
                    ? <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
                    : <XCircle className="w-5 h-5 text-amber-500 shrink-0" />}
                <p className="text-sm font-semibold text-foreground">
                  {phase === 'running'
                    ? `Removing… ${run?.processed ?? 0} of ${run?.total ?? selectedMatches.length} file(s)`
                    : run?.status === 'COMPLETED'
                      ? `Done — removed ${run?.removed ?? 0} page(s) across ${run?.processed ?? 0} file(s).`
                      : `Cancelled — ${run?.removed ?? 0} page(s) removed before stopping. Already-removed pages stay removed.`}
                </p>
              </div>
              <div className="w-full h-2 rounded bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              {phase === 'running' && (
                <p className="text-xs text-muted-foreground">
                  Runs on the server — it's safe to close this window. Progress also shows in Job History, and the admin bell announces completion.
                </p>
              )}
              {run?.failedCount > 0 && (
                <div className="p-3 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-500 space-y-1">
                  <p className="font-semibold">{run.failedCount} file(s) failed:</p>
                  {(run.failed || []).slice(0, 8).map((f: any, i: number) => (
                    <p key={i} className="truncate">{f.label}: {f.error}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="shrink-0 flex-col sm:flex-row gap-2 sm:items-center">
            {phase === 'review' && matches.length > 0 && (
              <span className="text-xs text-muted-foreground sm:mr-auto">
                {selectedMatches.length} page{selectedMatches.length !== 1 ? 's' : ''} in {selectedFiles} file{selectedFiles !== 1 ? 's' : ''} selected
              </span>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)} className="border-border hover:bg-muted">Close</Button>
            {phase === 'running' && (
              <Button variant="outline" disabled={cancelling} onClick={cancelSweep} className="border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10">
                {cancelling ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <XCircle className="w-4 h-4 mr-2" />} Cancel Sweep
              </Button>
            )}
            {phase === 'review' && (
              <Button
                variant="destructive"
                disabled={selectedMatches.length === 0 || enqueuing}
                onClick={() => setConfirmOpen(true)}
                className="font-bold"
              >
                {enqueuing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                Remove {selectedMatches.length} Page{selectedMatches.length !== 1 ? 's' : ''}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={startSweep}
        title="Remove this page everywhere?"
        description={`Delete ${selectedMatches.length} matched page${selectedMatches.length !== 1 ? 's' : ''} across ${selectedFiles} file${selectedFiles !== 1 ? 's' : ''} of this series? Each file is rewritten without its copy — this cannot be undone.`}
        confirmText="Start Sweep"
        variant="destructive"
        isLoading={enqueuing}
      />
    </>
  )
}
