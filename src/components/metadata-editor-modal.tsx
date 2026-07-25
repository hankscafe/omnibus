"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, FileText, FileX, AlertTriangle, Lock, Unlock } from "lucide-react"

export interface MetadataEditorSeries {
  currentPath: string
  name: string
  publisher?: string
  year?: string | number
  cvId?: string | number
  status?: string
  bookType?: string
  monitored?: boolean
  isManga?: boolean
  description?: string | null
  universe?: string | null
  seriesGroup?: string | null
}

export interface MetadataEditorIssue {
  id: string
  seriesName?: string
  number?: string
  name?: string | null
  releaseDate?: string | null
  universe?: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "series" | "issue"
  series?: MetadataEditorSeries
  issue?: MetadataEditorIssue
  onSaved?: (result?: any) => void
}

const ARRAY_FIELDS = ["writers", "artists", "coverArtists", "colorists", "letterers", "characters", "teams", "locations", "genres", "storyArcs"] as const

const joinArr = (v: any): string => (Array.isArray(v) ? v.filter(Boolean).join(", ") : (typeof v === "string" ? v : ""))
const splitArr = (s: string): string[] => (s || "").split(",").map(t => t.trim()).filter(Boolean)

export default function MetadataEditorModal({ open, onOpenChange, mode, series, issue, onSaved }: Props) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [writeToFile, setWriteToFile] = useState(true)
  const [form, setForm] = useState<Record<string, string>>({})
  // Authoritative series identity (fetched on open) so a metadata save never resets it.
  const [identity, setIdentity] = useState<Record<string, any>>({})
  // True when the current values couldn't be loaded — saving is then blocked so a blank
  // form can't wipe real metadata (e.g. the series folder is missing, or the API errored).
  const [loadFailed, setLoadFailed] = useState(false)
  // Manual-edits lock (issue.hasCustomMetadata): provider syncs preserve locked fields. The
  // editor surfaces it and offers the unlock so a wrongly-locked row can heal (issue #194 (f)).
  const [locked, setLocked] = useState(false)
  const [unlocking, setUnlocking] = useState(false)

  // Load current values + the global write-to-file default whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setLoadFailed(false)
      setLocked(false)
      // Global default for the write-to-file toggle.
      try {
        const cfg = await fetch("/api/admin/config").then(r => (r.ok ? r.json() : null)).catch(() => null)
        const wv = cfg?.settings?.find((s: any) => s.key === "metadata_write_comicinfo")?.value
        if (!cancelled) setWriteToFile(wv !== "false")
      } catch { /* default stays true */ }

      if (mode === "series" && series) {
        // Pull the authoritative current values so the editor always shows (and preserves) them,
        // regardless of which page opened it.
        let s: any = {}
        try {
          s = await fetch(`/api/library/series?path=${encodeURIComponent(series.currentPath)}`).then(r => (r.ok ? r.json() : {})).catch(() => ({})) || {}
        } catch { s = {} }
        if (cancelled) return
        // A real load echoes back the series identity (seriesName/path). If it didn't, the form
        // would show blanks and a save could wipe the real description/universe/seriesGroup.
        if (!s.seriesName && !s.path) { setLoadFailed(true); setLoading(false); return }
        setLocked(!!s.hasCustomMetadata)
        setIdentity({
          name: s.seriesName ?? series.name,
          publisher: s.publisher ?? series.publisher,
          year: s.year ?? series.year,
          status: s.status ?? series.status,
          bookType: s.bookType ?? series.bookType,
          monitored: s.monitored ?? series.monitored,
          isManga: s.isManga ?? series.isManga,
        })
        setForm({
          description: s.description ?? series.description ?? "",
          universe: s.universe ?? series.universe ?? "",
          seriesGroup: s.seriesGroup ?? series.seriesGroup ?? "",
        })
        setLoading(false)
        return
      }

      if (mode === "issue" && issue) {
        // The credit/character arrays + (possibly deep-fetched) description come from the issue API.
        let detail: any = {}
        try {
          detail = await fetch(`/api/library/issue?id=${encodeURIComponent(issue.id)}`).then(r => (r.ok ? r.json() : {})).catch(() => ({})) || {}
        } catch { detail = {} }
        if (cancelled) return
        // A successful issue load always returns the credit arrays. If it didn't, the form would
        // show blanks and a save could wipe the real writers/artists/characters/etc.
        if (!Array.isArray(detail.writers)) { setLoadFailed(true); setLoading(false); return }
        setLocked(!!detail.hasCustomMetadata)
        setForm({
          number: detail.number ?? issue.number ?? "",
          name: detail.name ?? issue.name ?? "",
          releaseDate: detail.releaseDate ?? issue.releaseDate ?? "",
          universe: detail.universe ?? issue.universe ?? "",
          description: detail.description || "",
          writers: joinArr(detail.writers),
          artists: joinArr(detail.artists),
          coverArtists: joinArr(detail.coverArtists),
          colorists: joinArr(detail.colorists),
          letterers: joinArr(detail.letterers),
          characters: joinArr(detail.characters),
          teams: joinArr(detail.teams),
          locations: joinArr(detail.locations),
          genres: joinArr(detail.genres),
          storyArcs: joinArr(detail.storyArcs),
        })
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [open, mode, series, issue])

  const set = (k: string, v: string) => setForm(prev => ({ ...prev, [k]: v }))

  const handleSave = async () => {
    if (loadFailed) return // never save over an unloaded (blank) form
    setSaving(true)
    try {
      let res: Response
      if (mode === "series" && series) {
        res = await fetch("/api/library/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Preserve identity (from the authoritative fetch) so the route doesn't reset it.
            // cvId is intentionally omitted so the existing provider id/source is never touched.
            currentPath: series.currentPath,
            name: identity.name ?? series.name,
            year: identity.year ?? series.year,
            publisher: identity.publisher ?? series.publisher,
            status: identity.status ?? series.status,
            bookType: identity.bookType ?? series.bookType,
            monitored: identity.monitored ?? series.monitored,
            isManga: identity.isManga ?? series.isManga,
            // Edited metadata.
            description: form.description,
            universe: form.universe,
            seriesGroup: form.seriesGroup,
            lockMetadata: true,
            writeToFile,
          }),
        })
      } else if (mode === "issue" && issue) {
        const payload: Record<string, any> = {
          issueId: issue.id,
          number: form.number,
          name: form.name,
          description: form.description,
          releaseDate: form.releaseDate,
          universe: form.universe,
          writeToFile,
        }
        for (const f of ARRAY_FIELDS) payload[f] = splitArr(form[f] || "")
        res = await fetch("/api/library/issue", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      } else {
        return
      }

      const result = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(result.error || `Save failed (${res.status})`)
      }

      // A zero-change save is a server-side no-op: nothing written, locked, or embedded.
      if (result?.changed === false) {
        toast({
          title: "No changes to save",
          description: "Nothing was modified, so the issue was left untouched (no lock, no file write).",
        })
      } else {
        toast({
          title: "Metadata saved",
          description: writeToFile ? "Changes saved and queued to write into ComicInfo.xml." : "Changes saved in Omnibus (files left untouched).",
        })
      }
      onOpenChange(false)
      onSaved?.(result)
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message || "Unknown error", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  // Clears hasCustomMetadata (and, for issues, the DEEP_SYNCED stamp) so provider syncs and the
  // lazy enrichment may refill the record again. The modal stays open so the notice visibly clears.
  const handleUnlock = async () => {
    setUnlocking(true)
    try {
      let res: Response
      if (mode === "issue" && issue) {
        res = await fetch("/api/library/issue", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId: issue.id, clearCustomMetadata: true }),
        })
      } else if (mode === "series" && series) {
        res = await fetch("/api/library/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPath: series.currentPath, clearCustomMetadata: true }),
        })
      } else {
        return
      }
      const result = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(result.error || `Unlock failed (${res.status})`)
      setLocked(false)
      toast({
        title: "Lock removed",
        description: mode === "issue"
          ? "Run Refresh Metadata on the series to pull provider data back into this issue."
          : "The next metadata refresh may update this series' description again.",
      })
      onSaved?.(result)
    } catch (e: any) {
      toast({ title: "Unlock failed", description: e?.message || "Unknown error", variant: "destructive" })
    } finally {
      setUnlocking(false)
    }
  }

  const arrField = (key: string, label: string) => (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        value={form[key] || ""}
        onChange={e => set(key, e.target.value)}
        placeholder="Comma-separated"
        className="bg-background border-border h-9"
      />
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] flex flex-col bg-background border-border rounded-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{mode === "series" ? "Edit Series Metadata" : "Edit Issue Metadata"}</DialogTitle>
          <DialogDescription>
            {mode === "series"
              ? `Descriptive metadata for ${series?.name || "this series"}.`
              : `ComicInfo metadata for ${issue?.seriesName ? issue.seriesName + " " : ""}#${issue?.number ?? ""}.`}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading metadata…
          </div>
        ) : loadFailed ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
            <AlertTriangle className="w-8 h-8 text-amber-500" />
            <p className="font-semibold text-foreground">Couldn’t load the current metadata</p>
            <p className="text-sm text-muted-foreground max-w-sm">
              {mode === "series"
                ? "The series record or its folder couldn’t be read, so editing is disabled to avoid overwriting existing data. Try again, or open the series page directly."
                : "This issue’s details couldn’t be read, so editing is disabled to avoid overwriting existing data. Please try again."}
            </p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto grid gap-4 py-2 pr-3">
            {mode === "issue" && (
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Number</Label>
                  <Input value={form.number || ""} onChange={e => set("number", e.target.value)} className="bg-background border-border h-9" />
                </div>
                <div className="grid gap-1.5 col-span-2">
                  <Label className="text-xs">Release Date</Label>
                  <Input value={form.releaseDate || ""} onChange={e => set("releaseDate", e.target.value)} placeholder="YYYY-MM-DD" className="bg-background border-border h-9" />
                </div>
              </div>
            )}

            {mode === "issue" && (
              <div className="grid gap-1.5">
                <Label className="text-xs">Title</Label>
                <Input value={form.name || ""} onChange={e => set("name", e.target.value)} className="bg-background border-border h-9" />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label className="text-xs">Summary / Description</Label>
              <Textarea value={form.description || ""} onChange={e => set("description", e.target.value)} rows={mode === "series" ? 5 : 4} className="bg-background border-border" />
            </div>

            {mode === "issue" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {arrField("writers", "Writers")}
                {arrField("artists", "Pencillers")}
                {arrField("coverArtists", "Cover Artists")}
                {arrField("colorists", "Colorists")}
                {arrField("letterers", "Letterers")}
                {arrField("characters", "Characters")}
                {arrField("teams", "Teams")}
                {arrField("locations", "Locations")}
                {arrField("genres", "Genres")}
                {arrField("storyArcs", "Story Arcs")}
              </div>
            )}

            {mode === "series" && (
              <div className="grid gap-1.5">
                <Label className="text-xs">Series Group</Label>
                <Input value={form.seriesGroup || ""} onChange={e => set("seriesGroup", e.target.value)} placeholder="Umbrella folder for related series" className="bg-background border-border h-9" />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label className="text-xs">Universe / Imprint</Label>
              <Input value={form.universe || ""} onChange={e => set("universe", e.target.value)} className="bg-background border-border h-9" />
            </div>

            {locked && (
              <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-500/10 border border-amber-500/40 p-3 rounded-lg">
                <div className="grid gap-0.5 flex-1 min-w-[14rem]">
                  <span className="text-sm font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" /> Manual-edits lock is on
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    {mode === "issue"
                      ? "Provider syncs and auto-enrichment preserve these fields. Remove the lock to let Refresh Metadata refill them from the provider."
                      : "Provider syncs preserve this series' description and related fields. Remove the lock to let metadata refreshes update them again."}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={unlocking} onClick={handleUnlock}
                  className="border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 shrink-0">
                  {unlocking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Unlock className="w-4 h-4 mr-2" />} Remove Lock
                </Button>
              </div>
            )}

            <div className="flex items-center gap-3 bg-muted/40 p-3 rounded-lg border border-border mt-1">
              <Switch id="meta-write-file" checked={writeToFile} onCheckedChange={setWriteToFile} />
              <div className="grid gap-0.5">
                <Label htmlFor="meta-write-file" className="cursor-pointer font-semibold flex items-center gap-1.5">
                  {writeToFile ? <FileText className="w-3.5 h-3.5" /> : <FileX className="w-3.5 h-3.5" />}
                  Write changes to ComicInfo.xml
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {writeToFile
                    ? "Edits are embedded into the comic file(s)."
                    : "Edits are kept in Omnibus only; files are left untouched."}
                </p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-border hover:bg-muted">Cancel</Button>
          <Button onClick={handleSave} disabled={saving || loading || loadFailed} className="bg-primary font-bold hover:bg-primary/90 text-primary-foreground">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Save Metadata
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
