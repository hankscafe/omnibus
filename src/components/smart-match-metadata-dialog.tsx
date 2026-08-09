"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import { COMIC_INFO_DEFAULT_KEYS, type ComicInfoDefaults } from "@/lib/utils/comicinfo-fields"
import { ComicInfoGeneralExtras, ComicInfoCreditsFields, ComicInfoStoryFields, ComicInfoDetailsFields } from "@/components/comicinfo-fields"
import { FileText, FileX, FolderTree, Check, Image as ImageIcon, Upload, Loader2, RefreshCw } from "lucide-react"
import { resolveIssueIdByNumber } from "@/lib/utils/smart-match-search"
import SmartMatchBoundIssue from "@/components/smart-match-bound-issue"

// #199 ComicInfo defaults: the field list + types live in the shared lib module (the API routes
// import it too) and the tab bodies come from the shared component module — the series metadata
// editor renders the same ones, so the two surfaces can't drift. Re-exported so existing
// consumers (the Smart Matcher page, tests) keep this import path.
export { COMIC_INFO_DEFAULT_KEYS } from "@/lib/utils/comicinfo-fields"
export type { ComicInfoDefaults } from "@/lib/utils/comicinfo-fields"

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
  /** #199 round 4 Beta B: 'keep' (default) = the files' data is primary, provider fills gaps;
   *  'replace' = explicit provider rewrite — Accept re-embeds ComicInfo.xml and regenerates
   *  series.json from the dialog's (provider-seeded) values. */
  dataMode?: 'keep' | 'replace'
  /** Loose files only: the issue's own title. Written to the issue on Accept; when an exact
   *  issue id is bound, the route locks the issue and lands provider credits in the same write. */
  issueTitle?: string
}

interface Seed {
  name?: string
  year?: string | number
  publisher?: string
  description?: string
  /** The provider's cover thumbnail (suggestion.image), shown as the current cover. */
  image?: string
}

/** #199 round 4: the library's own metadata for this item (server match-prefill payload) —
 *  values the files already carry, tagged with their source for badging. */
export interface DialogPrefill {
  fields: Record<string, { value: string; source: string }>
  blackAndWhite?: { value: boolean; source: string }
  issue?: { number: string | null; title: string | null }
}

/** The seeding rule (#199 round 4), exported for tests: an admin's saved override wins, the
 *  library's own files speak next, the provider suggestion only fills what neither claimed. */
export function seedValue(
  override: string | null | undefined,
  prefill: { value: string } | undefined,
  suggestion: string | null | undefined,
): string {
  if (override != null && String(override).trim() !== '') return String(override)
  if (prefill?.value) return prefill.value
  return suggestion != null ? String(suggestion) : ''
}

/** Which fields a provider-credit fill would touch: empty ones only — a fill can never overwrite
 *  the admin's or the files' values (#199 round 4, the never-destroy rule). Exported for tests. */
export function providerFillPlan(
  current: Record<string, string | undefined>,
  provider: Record<string, string> | undefined,
): Record<string, string> {
  const plan: Record<string, string> = {}
  for (const [k, v] of Object.entries(provider || {})) {
    if (!v || !String(v).trim()) continue
    if (current[k] && String(current[k]).trim() !== '') continue
    plan[k] = String(v)
  }
  return plan
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
  // #199 round 2, loose files only (showIssueCover): the auto cross-reference can bind the wrong
  // issue within a correctly-matched series (e.g. "4" extracted when the comic is #154). The
  // General tab shows the number, lets the admin fix it, and re-resolves the exact provider issue
  // ID from it — reported back to the page so Accept binds the corrected issue.
  /** Current issue number for the loose file (editable here). */
  issueNumber?: string
  /** The exact provider issue ID currently bound to this loose file — drives the read-only
   *  "bound issue" confirmation card so the admin can SEE which comic the ID points at
   *  (#199 round 3). Kept current by the page through onIssueIdChange / Issue Mapping. */
  issueId?: string
  /** Fires on every edit of the number field, keeping the page's Issue Mapping in sync. */
  onIssueNumberChange?: (v: string) => void
  /** Fires with the freshly-resolved exact issue ID after a successful refresh. */
  onIssueIdChange?: (id: string) => void
  /** The matched series' provider volume/series ID — needed to look up its issue list. */
  seriesMetadataId?: string | number
  /** COMICVINE or METRON — the provider seriesMetadataId belongs to. */
  metadataSource?: string
  /** #199 round 4: the item's own file-side metadata (ComicInfo.xml / series.json / scan) —
   *  seeds fields ahead of the provider suggestion, with source badges. */
  prefill?: DialogPrefill
  /** #199 round 4: the matched volume's aggregated credits (dialog-key CSVs) — the source for
   *  the explicit "fill empty fields from provider" action. Absent → the action hides. */
  providerFields?: Record<string, string>
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

export default function SmartMatchMetadataDialog({
  open, onOpenChange, targetLabel, seed, folderPattern, initialOverride, defaultWriteToFile = true,
  showIssueCover = false, archiveFilePath, initialIssueCover, initialIssueCoverFromArchive, onSave,
  issueNumber, issueId, onIssueNumberChange, onIssueIdChange, seriesMetadataId, metadataSource,
  prefill, providerFields,
}: Props) {
  const { toast } = useToast()
  // #199 round 2: set while "Refresh from number" is re-resolving the exact issue ID.
  const [refreshingIssueId, setRefreshingIssueId] = useState(false)
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
  // #199 round 4 Beta B: keep = files primary (default); replace = explicit provider rewrite.
  const [dataMode, setDataMode] = useState<'keep' | 'replace'>('keep')
  // Loose files only: the issue's own title (file-prefilled, editable).
  const [issueTitle, setIssueTitle] = useState('')

  // Field seeding, shared by dialog-open and the keep/replace switch (#199 round 4 Beta B).
  // keep: the admin's saved override, then the library's OWN files, then the provider suggestion.
  // replace: provider-fresh — the suggestion's core fields + the matched volume's credits; prior
  // edits and file values are deliberately discarded (that's what "replace" means, and the
  // warning copy says so).
  const applySeed = (mode: 'keep' | 'replace') => {
    if (mode === 'replace') {
      setName(seed?.name ?? '')
      setYear(seed?.year != null ? String(seed.year) : '')
      setPublisher(seed?.publisher ?? '')
      setUniverse('')
      setSeriesGroup('')
      setDescription(seed?.description ?? '')
      setFields(Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, providerFields?.[k] ?? ''])) as ComicInfoDefaults)
      setBlackAndWhite(false)
      setIssueTitle('')
      return
    }
    const pf = prefill?.fields
    setName(seedValue(initialOverride?.name, pf?.name, seed?.name))
    setYear(seedValue(initialOverride?.year, pf?.year, seed?.year != null ? String(seed.year) : ''))
    setPublisher(seedValue(initialOverride?.publisher, pf?.publisher, seed?.publisher))
    setUniverse(seedValue(initialOverride?.universe, pf?.universe, undefined))
    setSeriesGroup(seedValue(initialOverride?.seriesGroup, pf?.seriesGroup, undefined))
    setDescription(seedValue(initialOverride?.description, pf?.description, seed?.description))
    setFields(Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, seedValue(initialOverride?.[k], pf?.[k], undefined)])) as ComicInfoDefaults)
    setBlackAndWhite(initialOverride?.blackAndWhite ?? prefill?.blackAndWhite?.value ?? false)
    setIssueTitle(seedValue(initialOverride?.issueTitle, prefill?.issue?.title ? { value: prefill.issue.title } : undefined, undefined))
  }

  // Re-seed each time the dialog opens (a new target / fresh override).
  useEffect(() => {
    if (!open) return
    const mode = initialOverride?.dataMode ?? 'keep'
    setDataMode(mode)
    applySeed(mode)
    setWriteToFile(initialOverride?.writeToFile ?? defaultWriteToFile)
    setCoverDataUrl(initialOverride?.coverImageBase64 ?? null)
    // A previously-chosen issue cover means the opt-in was on; seed it back into the slot it came
    // from — the upload slot for real uploads only. An archive-sourced cover stays OUT of the upload
    // slot so a re-save keeps its provenance and still refuses to embed it (#199).
    setIssueCoverDataUrl(initialIssueCoverFromArchive ? null : (initialIssueCover ?? null))
    setUseArchiveCover(!!initialIssueCover)
    // Intentionally seed on open only — editing fields shouldn't reset them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Flipping the mode reseeds the fields to match its meaning; the admin can still edit after.
  const handleModeChange = (mode: 'keep' | 'replace') => {
    if (mode === dataMode) return
    setDataMode(mode)
    applySeed(mode)
  }

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

  // Provenance chip for a core field whose CURRENT value still equals what the files supplied —
  // it disappears the moment the admin edits, so the badge never lies (#199 round 4).
  const fileBadge = (key: string, current: string) => {
    const p = prefill?.fields?.[key]
    if (!p || p.value !== current) return null
    const label = p.source === 'series.json' ? 'series.json' : p.source === 'comicinfo' ? 'ComicInfo' : 'library scan'
    return (
      <span className="ml-1.5 text-[9px] uppercase tracking-wide font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-1 py-px align-middle">
        {label}
      </span>
    )
  }

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

  // #199 round 2: re-resolve the exact provider issue ID from the (corrected) number above. Lean by
  // design — it fixes the BINDING only; credits/title self-heal through the normal per-issue
  // enrichment once the right ID is stored, so nothing else needs to happen here.
  const handleRefreshIssueId = async () => {
    if (!issueNumber || !issueNumber.trim()) {
      toast({ title: "Enter the issue number first", description: "Refresh looks up the exact issue using this number.", variant: "destructive" })
      return
    }
    if (!seriesMetadataId) {
      toast({ title: "No series match yet", description: "This item isn't linked to a provider series yet — pick a match first.", variant: "destructive" })
      return
    }
    setRefreshingIssueId(true)
    try {
      const id = await resolveIssueIdByNumber({ issueNumber, seriesMetadataId, provider: metadataSource })
      if (!id) {
        toast({ title: "No matching issue found", description: `Couldn't find issue #${issueNumber} for this series on the provider.`, variant: "destructive" })
        return
      }
      onIssueIdChange?.(id)
      toast({ title: "Issue re-matched", description: `Now bound to issue #${issueNumber} — Accept will import it as that issue.` })
    } catch (e: any) {
      toast({ title: "Couldn't re-resolve", description: e?.message || "Unknown error", variant: "destructive" })
    } finally {
      setRefreshingIssueId(false)
    }
  }

  // #199 round 4: explicit provider gap-fill — empty fields only, never an overwrite. The plan
  // helper is the tested contract; this just applies it to the right state slots.
  const handleProviderFill = () => {
    const current: Record<string, string | undefined> = {
      name, year, publisher, description,
      ...Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, fields[k]])),
    }
    const provider: Record<string, string> = {
      ...(providerFields || {}),
      ...(seed?.name ? { name: seed.name } : {}),
      ...(seed?.year != null ? { year: String(seed.year) } : {}),
      ...(seed?.publisher ? { publisher: seed.publisher } : {}),
      ...(seed?.description ? { description: seed.description } : {}),
    }
    const plan = providerFillPlan(current, provider)
    const keys = Object.keys(plan)
    if (!keys.length) {
      toast({ title: 'Nothing to fill', description: 'Every field the provider knows already has a value.' })
      return
    }
    if (plan.name !== undefined) setName(plan.name)
    if (plan.year !== undefined) setYear(plan.year)
    if (plan.publisher !== undefined) setPublisher(plan.publisher)
    if (plan.description !== undefined) setDescription(plan.description)
    const defaultKeys = keys.filter(k => (COMIC_INFO_DEFAULT_KEYS as readonly string[]).includes(k))
    if (defaultKeys.length) setFields(f => ({ ...f, ...Object.fromEntries(defaultKeys.map(k => [k, plan[k]])) }))
    toast({ title: 'Gaps filled from provider', description: `${keys.length} empty field${keys.length === 1 ? '' : 's'} filled — your existing values were left untouched.` })
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
      dataMode,
      ...(showIssueCover ? { issueTitle: issueTitle.trim() || undefined } : {}),
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

        {/* #199 round 4: your files speak first. The summary says how much they said; the fill
            action is the ONLY way provider data enters an empty field, and it never overwrites. */}
        {(() => {
          const prefilledCount = Object.keys(prefill?.fields || {}).length + (prefill?.blackAndWhite ? 1 : 0)
          const hasProviderFill = Object.keys(providerFields || {}).length > 0
          if (!prefilledCount && !hasProviderFill) return null
          return (
            <div className="shrink-0 flex items-center justify-between gap-3 bg-muted/40 border border-border rounded-lg px-3 py-2">
              <p className="text-[11px] text-muted-foreground leading-snug">
                {prefilledCount > 0
                  ? `${prefilledCount} field${prefilledCount === 1 ? '' : 's'} pre-filled from your files' metadata — provider data never overwrites them.`
                  : 'No ComicInfo.xml / series.json metadata found for this item.'}
              </p>
              {hasProviderFill && (
                <Button type="button" size="sm" variant="outline" onClick={handleProviderFill}
                  title="Fill only the fields that are still empty using the matched volume's credits — existing values are never touched."
                  className="shrink-0 h-7 text-[11px] border-primary/30 text-primary hover:bg-primary/10 font-bold">
                  Fill empty fields from provider
                </Button>
              )}
            </div>
          )
        })()}

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
          {/* #199 round 2 (loose files): fix a misrecognized issue number and re-resolve the exact
              provider issue ID from it, without leaving the editor. */}
          {showIssueCover && (
            <div className="grid gap-2.5 pb-4 border-b border-border">
              <div className="flex items-end gap-2">
                <div className="grid gap-1.5 flex-1">
                  <Label htmlFor="sm-issue-number" className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold">Issue Number</Label>
                  <Input
                    id="sm-issue-number"
                    value={issueNumber || ""}
                    onChange={e => onIssueNumberChange?.(e.target.value)}
                    placeholder="e.g. 154"
                    className="bg-background border-border h-9"
                  />
                </div>
                <Button
                  type="button" size="sm" variant="outline" disabled={refreshingIssueId}
                  onClick={handleRefreshIssueId}
                  title="Wrong issue matched (right series, wrong number)? Fix the number, then re-resolve the exact issue ID from it."
                  className="shrink-0 h-9 border-primary/30 text-primary hover:bg-primary/10 font-bold"
                >
                  {refreshingIssueId ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                  Refresh from number
                </Button>
              </div>
              {/* #199 round 4 Beta B: the issue's OWN title — file-prefilled, editable. Accept
                  writes it to the issue; with an exact id bound, the route locks the issue and
                  lands provider credits in the same write so the lock never starves it. */}
              <div className="grid gap-1.5">
                <Label htmlFor="sm-issue-title" className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold">
                  Issue Title
                  {prefill?.issue?.title && issueTitle === prefill.issue.title && (
                    <span className="ml-1.5 text-[9px] uppercase tracking-wide font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-1 py-px align-middle">ComicInfo</span>
                  )}
                </Label>
                <Input
                  id="sm-issue-title"
                  value={issueTitle}
                  onChange={e => setIssueTitle(e.target.value)}
                  placeholder="e.g. L'alba dei morti viventi (optional)"
                  className="bg-background border-border h-9"
                />
              </div>
              {/* #199 round 3: show WHICH comic the bound ID points at — title, cover, credits —
                  so a wrong binding is visible before Accept, not after import. */}
              <SmartMatchBoundIssue issueId={issueId} provider={metadataSource} />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label className="text-xs">Series Name{fileBadge('name', name)}</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="bg-background border-border h-9" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Year{fileBadge('year', year)}</Label>
              <Input value={year} onChange={e => setYear(e.target.value)} placeholder="e.g. 2016" className="bg-background border-border h-9" />
            </div>
            <div className="grid gap-1.5 col-span-2">
              <Label className="text-xs">Publisher{fileBadge('publisher', publisher)}</Label>
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

          <ComicInfoGeneralExtras fields={fields} setField={setField} />

          <div className="grid gap-1.5">
            <Label className="text-xs">Summary / Description{fileBadge('description', description)}</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} className="bg-background border-border" />
          </div>
            </TabsContent>

            <TabsContent value="credits" className="grid gap-3 mt-0">
              <ComicInfoCreditsFields fields={fields} setField={setField} />
            </TabsContent>

            <TabsContent value="story" className="grid gap-3 mt-0">
              <ComicInfoStoryFields fields={fields} setField={setField} />
            </TabsContent>

            <TabsContent value="details" className="grid gap-3 mt-0">
              <ComicInfoDetailsFields fields={fields} setField={setField} blackAndWhite={blackAndWhite} setBlackAndWhite={v => setBlackAndWhite(v === true)} switchId="sm-bw" />
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

        {/* #199 round 4 Beta B: the data-source decision, explicit and safe-by-default. Keep =
            the files' values stay primary (what the fields show right now under keep seeding);
            Replace = provider rewrite, reseeding the fields and saying exactly what Accept will
            do to the files. Plain buttons on purpose (the tri-state B&W precedent — drivable,
            testable, no Radix portal). */}
        <div className="grid gap-1.5 mt-1 shrink-0">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleModeChange('keep')}
              className={`text-xs font-bold rounded-lg border px-3 py-2 transition-colors ${dataMode === 'keep'
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-border text-muted-foreground hover:bg-muted'}`}
            >
              Keep my data, fill gaps
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('replace')}
              className={`text-xs font-bold rounded-lg border px-3 py-2 transition-colors ${dataMode === 'replace'
                ? 'border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400'
                : 'border-border text-muted-foreground hover:bg-muted'}`}
            >
              Replace with provider data
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {dataMode === 'keep'
              ? 'Your files’ metadata stays primary; provider data only fills what’s empty. This protection also applies if you never open this dialog.'
              : '⚠ Provider data replaces these fields. On Accept, ComicInfo.xml is rewritten with them and this series’ series.json is regenerated. Your files’ previous metadata values are not kept.'}
          </p>
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
