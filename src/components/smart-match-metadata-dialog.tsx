"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { FileText, FileX, FolderTree, Check, Image as ImageIcon, Upload, Loader2 } from "lucide-react"

// Full ComicInfo.xml AgeRating enum (anansi-project schema) — a Select, so only valid values ship.
const AGE_RATING_OPTIONS = [
  "Unknown", "Adults Only 18+", "Early Childhood", "Everyone", "Everyone 10+", "G",
  "Kids to Adults", "M", "MA15+", "Mature 17+", "PG", "R18+", "Rating Pending", "Teen", "X18+",
]
const UNSET = "__unset__"

// #199 (concept by CapitanoNemo78): the free-text ComicInfo fields the Smart Matcher applies as
// series-wide defaults to every issue on match. "List" fields hold plain comma-separated text here;
// the API splits them into JSON array strings server-side (the Issue.writers convention).
export interface ComicInfoDefaults {
  imprint?: string
  format?: string
  languageISO?: string
  ageRating?: string
  writer?: string
  penciller?: string
  inker?: string
  colorist?: string
  letterer?: string
  coverArtist?: string
  editor?: string
  translator?: string
  genre?: string
  tags?: string
  characters?: string
  teams?: string
  locations?: string
  mainCharacterOrTeam?: string
  storyArc?: string
  storyArcNumber?: string
  alternateSeries?: string
  alternateNumber?: string
  alternateCount?: string
  communityRating?: string
  gtin?: string
  notes?: string
  scanInformation?: string
  review?: string
  /** Two-way by design (not in COMIC_INFO_DEFAULT_KEYS): true → <BlackAndWhite>Yes</>, false →
   *  clears back to unset. "No" is never claimed — absence reads as Unknown. */
  blackAndWhite?: boolean
}

// Exported so the Smart Matcher page can spread every default field into the match-series payload
// without re-listing all ~28 keys by hand. blackAndWhite is handled separately (boolean semantics).
export const COMIC_INFO_DEFAULT_KEYS = [
  "imprint", "format", "languageISO", "ageRating", "writer", "penciller", "inker", "colorist",
  "letterer", "coverArtist", "editor", "translator", "genre", "tags", "characters", "teams",
  "locations", "mainCharacterOrTeam", "storyArc", "storyArcNumber", "alternateSeries",
  "alternateNumber", "alternateCount", "communityRating", "gtin", "notes", "scanInformation", "review",
] as const

// The metadata an admin can pin to an unmatched item before accepting it. Stored per-item on the
// Smart Matcher page and merged into the /api/library/match-series request on Accept.
export interface SmartMatchOverride extends ComicInfoDefaults {
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
  /** True when issueCoverImageBase64 came from INSIDE the archive (the comic's own first page), not
   *  an upload. Such covers must never be embedded back into the file — the engine's insert-cover
   *  is insert-only (never replaces), so re-inserting the comic's own page duplicates it (#199). */
  issueCoverFromArchive?: boolean
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
  /** The loose file's path; used to fetch a preview of the comic's own (archive) cover art. */
  archiveFilePath?: string
  /** Current issue cover data URL (from the item's issue override), to re-edit. */
  initialIssueCover?: string
  /** Whether initialIssueCover was archive-sourced, so a reopen keeps its provenance (#199). */
  initialIssueCoverFromArchive?: boolean
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

// #199 duplicate guard: only genuinely uploaded covers are embed candidates. A cover sourced from
// inside the archive (the comic's own first page) must never be baked back in — the engine's
// insert-cover is insert-only by design (never replaces), so re-inserting duplicates page 0.
export function shouldEmbedIssueCover(
  ov: { coverImageBase64?: string; coverFromArchive?: boolean } | undefined,
  embedCoversEnabled: boolean,
): boolean | undefined {
  return ov?.coverImageBase64 && !ov.coverFromArchive ? embedCoversEnabled : undefined
}

// A plain labeled text input — the many one-line ComicInfo fields across the Credits/Story & Tags/
// Details tabs would otherwise repeat the same Label+Input markup ~25 times.
function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const id = "smf-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="bg-background border-border h-9" />
    </div>
  )
}

export default function SmartMatchMetadataDialog({
  open, onOpenChange, targetLabel, seed, folderPattern, initialOverride, defaultWriteToFile = true,
  showIssueCover = false, archiveFilePath, initialIssueCover, initialIssueCoverFromArchive, onSave,
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
  // The comic's own cover art, pulled from the archive's first page (data URL) for preview + reuse.
  const [archiveCoverDataUrl, setArchiveCoverDataUrl] = useState<string | null>(null)
  const [archiveCoverLoading, setArchiveCoverLoading] = useState(false)
  // Opt-in (default off): on → the issue cover is the comic's own art (uploaded or archive), locked
  // from auto-sync; off → the metadata provider supplies the issue cover (today's behavior).
  const [useArchiveCover, setUseArchiveCover] = useState(false)
  // #199 ComicInfo defaults (Credits/Story & Tags/Details tabs) — plain strings, comma-separated
  // for the list-type tags; the API splits them server-side. B&W is a real boolean (see interface).
  const [fields, setFields] = useState<ComicInfoDefaults>({})
  const setField = (k: keyof ComicInfoDefaults) => (v: string) => setFields(f => ({ ...f, [k]: v }))
  const [blackAndWhite, setBlackAndWhite] = useState(false)

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
    // A previously-chosen issue cover means the opt-in was on; seed it back into the slot it came
    // from — the upload slot for real uploads only. An archive-sourced cover stays OUT of the upload
    // slot so a re-save keeps its provenance and still refuses to embed it (#199).
    setIssueCoverDataUrl(initialIssueCoverFromArchive ? null : (initialIssueCover ?? null))
    setUseArchiveCover(!!initialIssueCover)
    setFields(Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, initialOverride?.[k] ?? ""])) as ComicInfoDefaults)
    setBlackAndWhite(initialOverride?.blackAndWhite ?? false)
    // Intentionally seed on open only — editing fields shouldn't reset them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Fetch the comic's own cover (archive first page) when the dialog opens for a loose file. Stored as
  // a data URL so it serves the preview AND rides the existing issueCoverImageBase64 save path verbatim.
  useEffect(() => {
    if (!open || !showIssueCover || !archiveFilePath) {
      setArchiveCoverDataUrl(null); setArchiveCoverLoading(false); return
    }
    let cancelled = false
    const controller = new AbortController()
    // If the archive render fails on a REOPEN of a previously-saved archive cover (engine hiccup,
    // CBR 415), fall back to that saved image — Save must not silently drop the admin's choice (#199).
    const fallback = initialIssueCoverFromArchive ? (initialIssueCover ?? null) : null
    setArchiveCoverDataUrl(null); setArchiveCoverLoading(true)
    fetch(`/api/library/archive-cover?path=${encodeURIComponent(archiveFilePath)}`, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) return null // 415 for CBR/RAR, 404 if no images — fall back to the provider cover.
        const blob = await res.blob()
        return await new Promise<string | null>(resolve => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })
      })
      .then(dataUrl => { if (!cancelled) setArchiveCoverDataUrl(dataUrl ?? fallback) })
      .catch(() => { if (!cancelled) setArchiveCoverDataUrl(fallback) })
      .finally(() => { if (!cancelled) setArchiveCoverLoading(false) })
    return () => { cancelled = true; controller.abort() }
  }, [open, showIssueCover, archiveFilePath, initialIssueCover, initialIssueCoverFromArchive])

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
    // Opt-in only: uploaded image wins, else the archive cover; off → the provider supplies it.
    const issueCover = useArchiveCover ? (issueCoverDataUrl || archiveCoverDataUrl || undefined) : undefined
    onSave({
      name: name.trim(),
      year: year.trim(),
      publisher: publisher.trim(),
      universe: universe.trim(),
      seriesGroup: seriesGroup.trim(),
      description,
      // #199 ComicInfo defaults: trimmed, empty → undefined (the undefined-means-untouched contract,
      // same as universe/seriesGroup on the page side)…
      ...(Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, (fields[k] || "").trim() || undefined])) as Partial<ComicInfoDefaults>),
      // …except the B&W switch, which is deliberately two-way: false must CLEAR a mistaken Yes.
      blackAndWhite,
      coverImageBase64: coverDataUrl || undefined,
      issueCoverImageBase64: issueCover,
      // No upload in play → the image IS the archive's own first page; flag it so Accept never
      // embeds it back into the file (#199 duplicate guard).
      issueCoverFromArchive: issueCover && !issueCoverDataUrl ? true : undefined,
      writeToFile,
      locked: true,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] flex flex-col bg-background border-border rounded-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Edit Match Metadata</DialogTitle>
          <DialogDescription>
            Fill in the ComicInfo details{targetLabel ? ` for “${targetLabel}”` : ""}. These are applied to every
            issue when you Accept the match (the series is locked from auto-sync).
          </DialogDescription>
        </DialogHeader>

        {/* #199 (concept by CapitanoNemo78): the full ComicInfo default set, tabbed so General stays
            as light as the old single-scroll dialog. Folder preview + write-file switch live OUTSIDE
            the tabs — they apply regardless of which tab is open. */}
        <Tabs defaultValue="general" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="shrink-0 w-full">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="credits">Credits</TabsTrigger>
            <TabsTrigger value="story">Story &amp; Tags</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="covers">Covers</TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0 overflow-y-auto pr-3 pt-3">
            <TabsContent value="general" className="grid gap-4 mt-0">
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

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <TextField label="Publisher Imprint" value={fields.imprint || ""} onChange={setField("imprint")} placeholder="e.g. Vertigo" />
            <TextField label="Format" value={fields.format || ""} onChange={setField("format")} placeholder="TPB, HC, Web, Digital…" />
            <TextField label="Language" value={fields.languageISO || ""} onChange={setField("languageISO")} placeholder="en, it, ja…" />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Age Rating</Label>
            <Select value={fields.ageRating || UNSET} onValueChange={v => setField("ageRating")(v === UNSET ? "" : v)}>
              <SelectTrigger className="bg-background border-border h-9 w-full"><SelectValue placeholder="Not set" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>Not set</SelectItem>
                {AGE_RATING_OPTIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Summary / Description</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} className="bg-background border-border" />
          </div>
            </TabsContent>

            <TabsContent value="credits" className="grid gap-3 mt-0">
              <p className="text-[11px] text-muted-foreground -mt-1">
                Comma-separated names, applied to every issue in this series unless an issue already has its own.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField label="Writer" value={fields.writer || ""} onChange={setField("writer")} />
                <TextField label="Penciller" value={fields.penciller || ""} onChange={setField("penciller")} />
                <TextField label="Inker" value={fields.inker || ""} onChange={setField("inker")} />
                <TextField label="Colorist" value={fields.colorist || ""} onChange={setField("colorist")} />
                <TextField label="Letterer" value={fields.letterer || ""} onChange={setField("letterer")} />
                <TextField label="Cover Artist" value={fields.coverArtist || ""} onChange={setField("coverArtist")} />
                <TextField label="Editor" value={fields.editor || ""} onChange={setField("editor")} />
                <TextField label="Translator" value={fields.translator || ""} onChange={setField("translator")} />
              </div>
            </TabsContent>

            <TabsContent value="story" className="grid gap-3 mt-0">
              <p className="text-[11px] text-muted-foreground -mt-1">
                Comma-separated values, applied to every issue in this series unless an issue already has its own.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField label="Genre" value={fields.genre || ""} onChange={setField("genre")} placeholder="Science-Fiction, Superhero…" />
                <TextField label="Tags" value={fields.tags || ""} onChange={setField("tags")} placeholder="ninja, school life…" />
                <TextField label="Characters" value={fields.characters || ""} onChange={setField("characters")} />
                <TextField label="Teams" value={fields.teams || ""} onChange={setField("teams")} />
                <TextField label="Locations" value={fields.locations || ""} onChange={setField("locations")} />
                <TextField label="Main Character / Team" value={fields.mainCharacterOrTeam || ""} onChange={setField("mainCharacterOrTeam")} />
                <TextField label="Story Arc" value={fields.storyArc || ""} onChange={setField("storyArc")} />
                <TextField label="Story Arc Number" value={fields.storyArcNumber || ""} onChange={setField("storyArcNumber")} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 border-t border-border">
                <TextField label="Alternate Series" value={fields.alternateSeries || ""} onChange={setField("alternateSeries")} />
                <TextField label="Alternate Number" value={fields.alternateNumber || ""} onChange={setField("alternateNumber")} />
                <TextField label="Alternate Count" value={fields.alternateCount || ""} onChange={setField("alternateCount")} placeholder="e.g. 6" />
              </div>
            </TabsContent>

            <TabsContent value="details" className="grid gap-3 mt-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Community Rating</Label>
                  <Input type="number" min={0} max={5} step={0.1} value={fields.communityRating || ""}
                    onChange={e => setField("communityRating")(e.target.value)} placeholder="0.0 - 5.0" className="bg-background border-border h-9" />
                </div>
                <TextField label="GTIN" value={fields.gtin || ""} onChange={setField("gtin")} placeholder="ISBN / ISSN / EAN" />
              </div>

              <div className="flex items-center gap-3 bg-muted/40 p-2.5 rounded-lg border border-border">
                <Switch id="sm-bw" checked={blackAndWhite} onCheckedChange={setBlackAndWhite} />
                <Label htmlFor="sm-bw" className="cursor-pointer text-xs">Black and White</Label>
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs">Notes</Label>
                <Textarea value={fields.notes || ""} onChange={e => setField("notes")(e.target.value)} rows={3} className="bg-background border-border" />
              </div>
              <TextField label="Scan Information" value={fields.scanInformation || ""} onChange={setField("scanInformation")} />
              <div className="grid gap-1.5">
                <Label className="text-xs">Review</Label>
                <Textarea value={fields.review || ""} onChange={e => setField("review")(e.target.value)} rows={3} className="bg-background border-border" />
              </div>
            </TabsContent>

            <TabsContent value="covers" className="grid gap-4 mt-0">
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

          {/* Issue cover (loose files become one issue). Off by default: the provider supplies the cover.
              Toggle on to use the comic's own cover art — the archive's first page, or an upload. */}
          {showIssueCover && (
            <div className="grid gap-1.5">
              <Label className="text-xs flex items-center gap-1.5"><ImageIcon className="w-3.5 h-3.5" /> Issue Cover</Label>

              <div className="flex items-center gap-3 bg-muted/40 p-2.5 rounded-lg border border-border">
                <Switch id="sm-use-archive-cover" checked={useArchiveCover} onCheckedChange={setUseArchiveCover} />
                <Label htmlFor="sm-use-archive-cover" className="cursor-pointer text-xs leading-snug">
                  Use the comic&apos;s own cover art
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {useArchiveCover
                      ? "Saved as this issue's cover on import and locked from auto-sync."
                      : "Off — the metadata provider's issue cover is used."}
                  </span>
                </Label>
              </div>

              <div className="flex items-start gap-3">
                <div className={`w-[72px] h-[108px] shrink-0 rounded bg-muted border border-border overflow-hidden flex items-center justify-center transition-opacity ${useArchiveCover ? "" : "opacity-40"}`}>
                  {archiveCoverLoading
                    ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/50" />
                    : (issueCoverDataUrl || archiveCoverDataUrl)
                      ? <img src={(issueCoverDataUrl || archiveCoverDataUrl) as string} alt="Issue cover" className="w-full h-full object-cover" />
                      : <ImageIcon className="w-6 h-6 text-muted-foreground/40" />}
                </div>
                <div className="flex flex-col gap-2 min-w-0">
                  {/* Uploading also flips the toggle on — the admin clearly wants their own cover. */}
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 text-primary text-xs font-bold cursor-pointer hover:bg-primary/10 w-fit">
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => pickImage(e, url => { setIssueCoverDataUrl(url); setUseArchiveCover(true) })} />
                    <Upload className="w-3.5 h-3.5" /> {issueCoverDataUrl ? "Replace image" : "Upload your own"}
                  </label>
                  {issueCoverDataUrl && archiveCoverDataUrl && (
                    <button type="button" onClick={() => setIssueCoverDataUrl(null)} className="text-[11px] text-muted-foreground hover:text-foreground w-fit underline">
                      Use the archive&apos;s cover instead
                    </button>
                  )}
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    {!useArchiveCover
                      ? "The metadata provider supplies this issue's cover."
                      : issueCoverDataUrl
                        ? "Your uploaded image is used for this issue."
                        : archiveCoverLoading
                          ? "Reading the cover from the comic…"
                          : archiveCoverDataUrl
                            ? "Using the cover pulled from the comic archive."
                            : "No cover could be read from the archive — upload one, or turn this off to use the provider's."}
                  </p>
                </div>
              </div>
            </div>
          )}
            </TabsContent>
          </div>
        </Tabs>

        {/* Live folder-path preview — exactly mirrors the path match-series will create. */}
        <div className="grid gap-1.5 shrink-0">
            <Label className="text-xs flex items-center gap-1.5 text-muted-foreground">
              <FolderTree className="w-3.5 h-3.5" /> Resulting folder
            </Label>
            <div className="text-xs font-mono break-all bg-muted/50 border border-border rounded-lg px-3 py-2 text-foreground">
              {preview || <span className="text-muted-foreground italic">Will use the series name once filled in.</span>}
            </div>
          </div>

        <div className="flex items-center gap-3 bg-muted/40 p-3 rounded-lg border border-border mt-1 shrink-0">
          <Switch id="sm-write-file" checked={writeToFile} onCheckedChange={setWriteToFile} />
          <div className="grid gap-0.5">
            <Label htmlFor="sm-write-file" className="cursor-pointer font-semibold flex items-center gap-1.5">
              {writeToFile ? <FileText className="w-3.5 h-3.5" /> : <FileX className="w-3.5 h-3.5" />}
              Write changes to ComicInfo.xml
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {writeToFile
                ? "All the fields above are embedded into the comic file(s) after the match."
                : "Kept in Omnibus only; files are left untouched."}
            </p>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-border hover:bg-muted text-foreground">Cancel</Button>
          <Button onClick={handleSave} className="bg-primary font-bold hover:bg-primary/90 text-primary-foreground">
            <Check className="w-4 h-4 mr-2" /> Save Details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
