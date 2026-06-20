"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { FileText, FileX, FolderTree, Check } from "lucide-react"

// The metadata an admin can pin to an unmatched item before accepting it. Stored per-item on the
// Smart Matcher page and merged into the /api/library/match-series request on Accept.
export interface SmartMatchOverride {
  name?: string
  year?: string
  publisher?: string
  universe?: string
  seriesGroup?: string
  description?: string
  writeToFile?: boolean
  locked?: boolean
}

interface Seed {
  name?: string
  year?: string | number
  publisher?: string
  description?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Folder/file name shown in the header so the admin knows which item they're editing. */
  targetLabel?: string
  /** Seed values from the current suggestion / Custom ID lookup. */
  seed?: Seed
  /** The active folder_naming_pattern, used to render the live folder-path preview. */
  folderPattern: string
  /** An existing override to re-edit. */
  initialOverride?: SmartMatchOverride
  /** Global default for the write-to-ComicInfo.xml toggle (metadata_write_comicinfo). */
  defaultWriteToFile?: boolean
  onSave: (override: SmartMatchOverride) => void
}

// Mirrors the token substitution in /api/library/match-series EXACTLY so the preview matches the
// folder that will actually be created. Inlined (not @/lib/utils/sanitize) because that module pulls
// in sanitize-html, a server-only dependency we don't want in the client bundle.
const sanitizePart = (s: string) => (s || "").replace(/[<>:"/\\|?*]/g, "").trim()

export function buildFolderPreview(
  pattern: string,
  v: { name?: string; year?: string | number; publisher?: string; universe?: string; seriesGroup?: string }
): string {
  const yr = v.year != null ? v.year.toString() : ""
  const out = (pattern || "{Publisher}/{Series} ({Year})")
    .replace(/{Publisher}/gi, sanitizePart(v.publisher || "") || "Other")
    .replace(/{Series}/gi, sanitizePart(v.name || "") || "Unknown Series")
    .replace(/{Year}/gi, yr)
    .replace(/{VolumeYear}/gi, yr)
    .replace(/{UniverseName}/gi, sanitizePart(v.universe || ""))
    .replace(/{SeriesGroup}/gi, sanitizePart(v.seriesGroup || ""))
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return out.split(/[/\\]/).map(p => p.trim()).filter(Boolean).join("/")
}

export default function SmartMatchMetadataDialog({
  open, onOpenChange, targetLabel, seed, folderPattern, initialOverride, defaultWriteToFile = true, onSave,
}: Props) {
  const [name, setName] = useState("")
  const [year, setYear] = useState("")
  const [publisher, setPublisher] = useState("")
  const [universe, setUniverse] = useState("")
  const [seriesGroup, setSeriesGroup] = useState("")
  const [description, setDescription] = useState("")
  const [writeToFile, setWriteToFile] = useState(defaultWriteToFile)

  // Re-seed each time the dialog opens (a new target / fresh override). Prefer the existing override,
  // then the suggestion seed, then blank.
  useEffect(() => {
    if (!open) return
    setName(initialOverride?.name ?? seed?.name ?? "")
    setYear(initialOverride?.year ?? (seed?.year != null ? String(seed.year) : ""))
    setPublisher(initialOverride?.publisher ?? seed?.publisher ?? "")
    setUniverse(initialOverride?.universe ?? "")
    setSeriesGroup(initialOverride?.seriesGroup ?? "")
    setDescription(initialOverride?.description ?? seed?.description ?? "")
    setWriteToFile(initialOverride?.writeToFile ?? defaultWriteToFile)
    // Intentionally seed on open only — editing fields shouldn't reset them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const preview = buildFolderPreview(folderPattern, { name, year, publisher, universe, seriesGroup })

  const handleSave = () => {
    onSave({
      name: name.trim(),
      year: year.trim(),
      publisher: publisher.trim(),
      universe: universe.trim(),
      seriesGroup: seriesGroup.trim(),
      description,
      writeToFile,
      locked: true,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col bg-background border-border rounded-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Edit Match Metadata</DialogTitle>
          <DialogDescription>
            Fill in the details that build the folder name{targetLabel ? ` for “${targetLabel}”` : ""}. These are
            applied when you Accept the match and kept (the series is locked from auto-sync).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto grid gap-4 py-2 pr-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">Series Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="bg-background border-border h-9" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Year</Label>
              <Input value={year} onChange={e => setYear(e.target.value)} placeholder="e.g. 2016" className="bg-background border-border h-9" />
            </div>
            <div className="grid gap-1.5 col-span-2">
              <Label className="text-xs">Publisher</Label>
              <Input value={publisher} onChange={e => setPublisher(e.target.value)} className="bg-background border-border h-9" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Series Group</Label>
              <Input value={seriesGroup} onChange={e => setSeriesGroup(e.target.value)} placeholder="Umbrella folder for related series" className="bg-background border-border h-9" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Universe / Imprint</Label>
              <Input value={universe} onChange={e => setUniverse(e.target.value)} placeholder="e.g. Earth-616" className="bg-background border-border h-9" />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Summary / Description</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} className="bg-background border-border" />
          </div>

          {/* Live folder-path preview — exactly mirrors the path match-series will create. */}
          <div className="grid gap-1.5">
            <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
              <FolderTree className="w-3.5 h-3.5" /> Resulting folder
            </Label>
            <div className="text-xs font-mono break-all bg-muted/50 border border-border rounded-lg px-3 py-2 text-foreground">
              {preview || <span className="text-muted-foreground italic">Will use the series name once filled in.</span>}
            </div>
          </div>

          <div className="flex items-center gap-3 bg-muted/40 p-3 rounded-lg border border-border mt-1">
            <Switch id="sm-write-file" checked={writeToFile} onCheckedChange={setWriteToFile} />
            <div className="grid gap-0.5">
              <Label htmlFor="sm-write-file" className="cursor-pointer font-semibold flex items-center gap-1.5">
                {writeToFile ? <FileText className="w-3.5 h-3.5" /> : <FileX className="w-3.5 h-3.5" />}
                Write changes to ComicInfo.xml
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {writeToFile
                  ? "Series Group, Universe and Description are embedded into the comic file(s) after the match."
                  : "Kept in Omnibus only; files are left untouched."}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-border hover:bg-muted text-foreground">Cancel</Button>
          <Button onClick={handleSave} className="bg-primary font-bold hover:bg-primary/90 text-primary-foreground">
            <Check className="w-4 h-4 mr-2" /> Save Details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
