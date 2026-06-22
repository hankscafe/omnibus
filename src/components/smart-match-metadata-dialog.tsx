"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { FileText, FileX, FolderTree, Check, Image as ImageIcon, Upload } from "lucide-react"

// The metadata an admin can pin to an unmatched item before accepting it. Stored per-item on the
// Smart Matcher page and merged into the /api/library/match-series request on Accept.
export interface SmartMatchOverride {
  name?: string
  year?: string
  publisher?: string
  universe?: string
  seriesGroup?: string
  description?: string
  /** A data-URL cover image the admin chose; written to <folder>/cover.jpg on import + locked. */
  coverImageBase64?: string
  /** A data-URL issue cover (loose files only); written to the issue's cover + locked on import. */
  issueCoverImageBase64?: string
  writeToFile?: boolean
  locked?: boolean
}

interface Seed {
  name?: string
  year?: string | number
  publisher?: string
  description?: string
  /** The provider's cover thumbnail (suggestion.image), shown as the current cover. */
  image?: string
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
  /** Show the per-issue cover picker (loose files become a single issue). */
  showIssueCover?: boolean
  /** Current issue cover data URL (from the item's issue override), to re-edit. */
  initialIssueCover?: string
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
  open, onOpenChange, targetLabel, seed, folderPattern, initialOverride, defaultWriteToFile = true,
  showIssueCover = false, initialIssueCover, onSave,
}: Props) {
  const { toast } = useToast()
  const [name, setName] = useState("")
  const [year, setYear] = useState("")
  const [publisher, setPublisher] = useState("")
  const [universe, setUniverse] = useState("")
  const [seriesGroup, setSeriesGroup] = useState("")
  const [description, setDescription] = useState("")
  const [writeToFile, setWriteToFile] = useState(defaultWriteToFile)
  // Admin-chosen covers as data URLs; null = use the provider/automatic cover.
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null)
  const [issueCoverDataUrl, setIssueCoverDataUrl] = useState<string | null>(null)

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
    setCoverDataUrl(initialOverride?.coverImageBase64 ?? null)
    setIssueCoverDataUrl(initialIssueCover ?? null)
    // Intentionally seed on open only — editing fields shouldn't reset them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const preview = buildFolderPreview(folderPattern, { name, year, publisher, universe, seriesGroup })

  // Reads the picked file into a data URL via `setUrl` (shared by the series + issue cover pickers).
  const pickImage = (e: React.ChangeEvent<HTMLInputElement>, setUrl: (v: string) => void) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    if (!file) return
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Choose an image under 15MB.", variant: "destructive" })
      return
    }
    const reader = new FileReader()
    reader.onload = () => setUrl(reader.result as string)
    reader.onerror = () => toast({ title: "Couldn't read image", variant: "destructive" })
    reader.readAsDataURL(file)
  }

  const handleSave = () => {
    onSave({
      name: name.trim(),
      year: year.trim(),
      publisher: publisher.trim(),
      universe: universe.trim(),
      seriesGroup: seriesGroup.trim(),
      description,
      coverImageBase64: coverDataUrl || undefined,
      issueCoverImageBase64: issueCoverDataUrl || undefined,
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

          {/* Series cover — written to <folder>/cover.jpg + locked on import. */}
          <div className="grid gap-1.5">
            <Label className="text-xs flex items-center gap-1.5"><ImageIcon className="w-3.5 h-3.5" /> Series Cover</Label>
            <div className="flex items-start gap-3">
              <div className="w-[72px] h-[108px] shrink-0 rounded bg-muted border border-border overflow-hidden flex items-center justify-center">
                {coverDataUrl || seed?.image
                  ? <img src={coverDataUrl || seed?.image} alt="Series cover" className="w-full h-full object-cover" />
                  : <ImageIcon className="w-6 h-6 text-muted-foreground/40" />}
              </div>
              <div className="flex flex-col gap-2 min-w-0">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 text-primary text-xs font-bold cursor-pointer hover:bg-primary/10 w-fit">
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => pickImage(e, setCoverDataUrl)} />
                  <Upload className="w-3.5 h-3.5" /> {coverDataUrl ? "Replace image" : "Choose image"}
                </label>
                {coverDataUrl && (
                  <button type="button" onClick={() => setCoverDataUrl(null)} className="text-[11px] text-muted-foreground hover:text-foreground w-fit underline">
                    Use the {seed?.image ? "provider" : "automatic"} cover instead
                  </button>
                )}
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {coverDataUrl
                    ? "Saved as the series cover on import and locked from auto-sync."
                    : seed?.image
                      ? "Using the provider's cover. Upload to override it."
                      : "No provider cover — upload one, or the comic's first page is used."}
                </p>
              </div>
            </div>
          </div>

          {/* Issue cover — loose files become one issue; written to that issue's cover + locked. */}
          {showIssueCover && (
            <div className="grid gap-1.5">
              <Label className="text-xs flex items-center gap-1.5"><ImageIcon className="w-3.5 h-3.5" /> Issue Cover</Label>
              <div className="flex items-start gap-3">
                <div className="w-[72px] h-[108px] shrink-0 rounded bg-muted border border-border overflow-hidden flex items-center justify-center">
                  {issueCoverDataUrl
                    ? <img src={issueCoverDataUrl} alt="Issue cover" className="w-full h-full object-cover" />
                    : <ImageIcon className="w-6 h-6 text-muted-foreground/40" />}
                </div>
                <div className="flex flex-col gap-2 min-w-0">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 text-primary text-xs font-bold cursor-pointer hover:bg-primary/10 w-fit">
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => pickImage(e, setIssueCoverDataUrl)} />
                    <Upload className="w-3.5 h-3.5" /> {issueCoverDataUrl ? "Replace image" : "Choose image"}
                  </label>
                  {issueCoverDataUrl && (
                    <button type="button" onClick={() => setIssueCoverDataUrl(null)} className="text-[11px] text-muted-foreground hover:text-foreground w-fit underline">
                      Use the provider's issue cover instead
                    </button>
                  )}
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {issueCoverDataUrl
                      ? "Saved as this issue's cover on import and locked from auto-sync."
                      : "The cover for this single file's issue. Provider's issue cover is used if left blank."}
                  </p>
                </div>
              </div>
            </div>
          )}

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
