// src/components/manual-upload-dialog.tsx
//
// Reusable manual-upload UI. `ManualUploadPanel` is the dropzone + per-file progress list (used by
// the /admin/upload page); `ManualUploadDialog` wraps it in a modal for the dashboard's
// "Upload File" button on Cloudflare-gated (MANUAL_DDL) requests.
//
// Each file is POSTed individually as the raw request body to /api/admin/upload so we get real
// upload progress (xhr.upload.onprogress) and never buffer a large comic in memory. Files land in
// WATCHED (default → auto-imported via watched-sync) or UNMATCHED (held for Smart Matcher).
"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { isComicFile, COMIC_EXTENSIONS } from "@/lib/utils/formats"
import { UploadCloud, FileText, X, Check, Loader2, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/utils/format"

type Destination = "watched" | "unmatched"
type ItemStatus = "queued" | "uploading" | "done" | "error"

interface UploadItem {
  id: string
  file: File
  status: ItemStatus
  progress: number
  error?: string
  finalName?: string
}

const ACCEPT = COMIC_EXTENSIONS.join(",")

// Chunk size: safely under Cloudflare's ~100MB free-plan edge cap (tunnel traffic goes through
// that edge and CANNOT be raised on free plans), with headroom for other proxies. Files at or
// below this size upload in one request, exactly as before.
const CHUNK_SIZE = 48 * 1024 * 1024

// Map an upload failure to an actionable message (a bare proxy status has no JSON body from us).
// Exported for tests.
export function uploadFailureMessage(status: number, serverError?: string): string {
  if (serverError) return serverError
  if (status === 413) {
    return "Rejected before reaching Omnibus (HTTP 413): a proxy in front of the server capped this upload — Cloudflare allows ~100MB per request on free plans, nginx defaults to 1MB (client_max_body_size). If this persists, upload via the server's local address."
  }
  if (status === 409) return "Upload session got out of sync — please retry the file."
  if (status === 0) return "Network error during upload."
  return `Upload failed (HTTP ${status}).`
}

// POST one raw body (a whole file or a single chunk), reporting absolute bytes progressed.
function sendBody(
  qs: URLSearchParams,
  body: Blob,
  onProgress: (loaded: number) => void,
): Promise<{ ok: boolean; status: number; error?: string; filename?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `/api/admin/upload?${qs.toString()}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    }
    xhr.onload = () => {
      let res: { success?: boolean; filename?: string; error?: string } = {}
      try {
        res = JSON.parse(xhr.responseText || "{}")
      } catch {
        /* non-JSON response (proxy error page) — uploadFailureMessage supplies the guidance */
      }
      if (xhr.status >= 200 && xhr.status < 300 && res.success) resolve({ ok: true, status: xhr.status, filename: res.filename })
      else resolve({ ok: false, status: xhr.status, error: res.error })
    }
    xhr.onerror = () => resolve({ ok: false, status: 0 })
    xhr.send(body)
  })
}

// Upload one file. Files above CHUNK_SIZE are sliced and sent sequentially under a shared
// uploadId; the server verifies each chunk's byte offset before appending and reassembles
// (Cloudflare-tunnel safe). The last chunk's response carries the final filename.
async function uploadOne(
  file: File,
  destination: Destination,
  requestId: string | undefined,
  onProgress: (pct: number) => void,
): Promise<{ ok: boolean; error?: string; filename?: string }> {
  const baseQs = () => {
    const qs = new URLSearchParams({ destination, filename: file.name })
    if (requestId) qs.set("requestId", requestId)
    return qs
  }

  if (file.size <= CHUNK_SIZE) {
    const res = await sendBody(baseQs(), file, (loaded) => onProgress(Math.round((loaded / Math.max(1, file.size)) * 100)))
    return res.ok ? { ok: true, filename: res.filename } : { ok: false, error: uploadFailureMessage(res.status, res.error) }
  }

  const uploadId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, "")
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE
    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size))
    const qs = baseQs()
    qs.set("uploadId", uploadId)
    qs.set("chunkIndex", String(i))
    qs.set("totalChunks", String(totalChunks))
    qs.set("chunkOffset", String(offset))
    const res = await sendBody(qs, slice, (loaded) => onProgress(Math.round(((offset + loaded) / file.size) * 100)))
    if (!res.ok) return { ok: false, error: uploadFailureMessage(res.status, res.error) }
    if (i === totalChunks - 1) return { ok: true, filename: res.filename }
  }
  return { ok: false, error: "Upload ended unexpectedly." }
}

export function ManualUploadPanel({
  defaultDestination = "watched",
  lockDestination = false,
  requestId,
  onComplete,
}: {
  defaultDestination?: Destination
  lockDestination?: boolean
  requestId?: string
  onComplete?: () => void
}) {
  const { toast } = useToast()
  const [items, setItems] = useState<UploadItem[]>([])
  const [destination, setDestination] = useState<Destination>(defaultDestination)
  const [startImport, setStartImport] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const queuedCount = items.filter((i) => i.status === "queued").length
  const hasEpubQueued = items.some((i) => i.status === "queued" && /\.epub$/i.test(i.file.name))

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const incoming = Array.from(fileList)
    const rejected = incoming.filter((f) => !isComicFile(f.name))
    const accepted = incoming.filter((f) => isComicFile(f.name))
    if (rejected.length) {
      toast({
        title: "Some files skipped",
        description: `${rejected.length} file(s) aren't supported comics (allowed: ${COMIC_EXTENSIONS.join(", ")}).`,
        variant: "destructive",
      })
    }
    if (!accepted.length) return
    setItems((prev) => [
      ...prev,
      ...accepted.map((file, idx) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${idx}`,
        file,
        status: "queued" as ItemStatus,
        progress: 0,
      })),
    ])
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  function patchItem(id: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  async function handleUpload() {
    const queued = items.filter((i) => i.status === "queued")
    if (!queued.length || isUploading) return
    setIsUploading(true)
    let success = 0
    let failed = 0

    for (const item of queued) {
      patchItem(item.id, { status: "uploading", progress: 0, error: undefined })
      const res = await uploadOne(item.file, destination, requestId, (pct) => patchItem(item.id, { progress: pct }))
      if (res.ok) {
        success++
        patchItem(item.id, { status: "done", progress: 100, finalName: res.filename })
      } else {
        failed++
        patchItem(item.id, { status: "error", error: res.error })
      }
    }

    // Kick the importer once for the whole batch (watched only — unmatched is read live by Smart Matcher).
    if (destination === "watched" && startImport && success > 0) {
      try {
        await fetch("/api/admin/jobs/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job: "watched_sync" }),
        })
      } catch {
        /* import can also be run manually from Scheduled Jobs */
      }
    }

    setIsUploading(false)
    toast({
      title: failed === 0 ? "Upload complete" : "Upload finished with errors",
      description:
        `${success} uploaded${failed ? `, ${failed} failed` : ""}` +
        (destination === "watched" && startImport && success ? " — import started." : "."),
      variant: failed ? "destructive" : undefined,
    })
    if (success > 0) onComplete?.()
  }

  return (
    <div className="space-y-4">
      {/* Destination selector */}
      {!lockDestination && (
        <div className="space-y-1.5">
          <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Destination</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDestination("watched")}
              className={cn(
                "rounded-md border p-3 text-left transition-colors",
                destination === "watched"
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <div className="text-sm font-bold text-foreground">Watched</div>
              <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">Auto-import &amp; match</div>
            </button>
            <button
              type="button"
              onClick={() => setDestination("unmatched")}
              className={cn(
                "rounded-md border p-3 text-left transition-colors",
                destination === "unmatched"
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-muted/50",
              )}
            >
              <div className="text-sm font-bold text-foreground">Unmatched</div>
              <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">Hold for Smart Matcher</div>
            </button>
          </div>
        </div>
      )}

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
        )}
      >
        <UploadCloud className="w-7 h-7 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">Drag &amp; drop files here, or click to browse</div>
        <div className="text-[11px] text-muted-foreground">{COMIC_EXTENSIONS.join(", ")}</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = "" // allow re-selecting the same file
          }}
        />
      </div>

      {destination === "watched" && hasEpubQueued && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          ePub files aren&apos;t auto-imported from Watched — choose <strong>Unmatched</strong> for ePub.
        </p>
      )}

      {/* File list */}
      {items.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-md border border-border bg-background p-2.5">
              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                {/* min-w-0 on the flex row AND the name span: flex items default to min-width:auto,
                    so a long unbreakable filename otherwise refuses to shrink and pushes the whole
                    panel (dropzone included) wider than the dialog. */}
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="text-xs font-medium text-foreground truncate min-w-0" title={item.file.name}>
                    {item.finalName && item.finalName !== item.file.name ? item.finalName : item.file.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{formatBytes(item.file.size)}</span>
                </div>
                {item.status === "uploading" && <Progress value={item.progress} className="mt-1.5 h-1.5" />}
                {item.status === "error" && <p className="text-[10px] text-destructive mt-1 break-words">{item.error}</p>}
              </div>
              <div className="shrink-0">
                {item.status === "queued" && (
                  <button type="button" onClick={() => removeItem(item.id)} title="Remove" disabled={isUploading}>
                    <X className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
                {item.status === "uploading" && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
                {item.status === "done" && <Check className="w-4 h-4 text-green-600" />}
                {item.status === "error" && <AlertCircle className="w-4 h-4 text-destructive" />}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between gap-3 pt-1">
        {destination === "watched" ? (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Checkbox
              checked={startImport}
              onCheckedChange={(v) => setStartImport(v === true)}
              disabled={isUploading}
            />
            <span className="text-xs text-muted-foreground">Start import after upload</span>
          </label>
        ) : (
          <span className="text-[11px] text-muted-foreground">Resolve these in Smart Matcher after upload.</span>
        )}
        <Button onClick={handleUpload} disabled={queuedCount === 0 || isUploading} className="font-bold">
          {isUploading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…
            </>
          ) : (
            <>
              <UploadCloud className="w-4 h-4 mr-2" /> Upload {queuedCount > 0 ? queuedCount : ""} file{queuedCount === 1 ? "" : "s"}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

export function ManualUploadDialog({
  open,
  onOpenChange,
  defaultDestination = "watched",
  lockDestination = false,
  requestId,
  onComplete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultDestination?: Destination
  lockDestination?: boolean
  requestId?: string
  onComplete?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Comic File</DialogTitle>
          <DialogDescription>
            Upload a manually-downloaded file. It&apos;s imported and matched just like a normal download.
          </DialogDescription>
        </DialogHeader>
        <ManualUploadPanel
          defaultDestination={defaultDestination}
          lockDestination={lockDestination}
          requestId={requestId}
          onComplete={onComplete}
        />
      </DialogContent>
    </Dialog>
  )
}
