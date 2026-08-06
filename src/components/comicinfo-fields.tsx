"use client"

// #199 ComicInfo defaults — the shared field UI. The Smart Matcher dialog and the series metadata
// editor render the SAME tab bodies from here, so the two surfaces can never drift. Pure data
// (field list, mappings, validation) lives in src/lib/utils/comicinfo-fields.ts, which routes also
// import; this module holds only the client pieces.
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AGE_RATING_OPTIONS, UNSET, type ComicInfoDefaults } from "@/lib/utils/comicinfo-fields"

export type SetComicInfoField = (k: keyof ComicInfoDefaults) => (v: string) => void

// A plain labeled text input — the many one-line ComicInfo fields would otherwise repeat the same
// Label+Input markup ~25 times. The id gives the label a real for/id association (a11y + tests).
export function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const id = "smf-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="bg-background border-border h-9" />
    </div>
  )
}

interface FieldsProps {
  fields: ComicInfoDefaults
  setField: SetComicInfoField
  /** Helper line above the fields. Default = the series-defaults copy; pass your own for other
   *  surfaces (the per-issue editor), or null to hide it. */
  intro?: string | null
}

/** General-tab extras: Publisher Imprint / Format / Language row + the AgeRating select. */
export function ComicInfoGeneralExtras({ fields, setField }: FieldsProps) {
  return (
    <>
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
    </>
  )
}

/** Credits tab body: the eight comma-separated credit fields. */
export function ComicInfoCreditsFields({ fields, setField, intro = "Comma-separated names, applied to every issue in this series unless an issue already has its own." }: FieldsProps) {
  return (
    <>
      {intro !== null && <p className="text-[11px] text-muted-foreground -mt-1">{intro}</p>}
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
    </>
  )
}

/** Story & Tags tab body: story descriptors + the alternate-series row. */
export function ComicInfoStoryFields({ fields, setField, intro = "Comma-separated values, applied to every issue in this series unless an issue already has its own." }: FieldsProps) {
  return (
    <>
      {intro !== null && <p className="text-[11px] text-muted-foreground -mt-1">{intro}</p>}
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
    </>
  )
}

interface DetailsProps extends FieldsProps {
  /** Switch surfaces (matcher, series editor) pass a plain boolean; the tri-state per-issue
   *  editor passes boolean | null (null = Unknown). */
  blackAndWhite: boolean | null
  setBlackAndWhite: (v: boolean | null) => void
  /** Render B&W as an Unknown/Yes/No segmented control instead of the two-way switch — the
   *  per-issue editor needs it because an explicit per-issue "No" is a real stored claim
   *  (#199 Call-3 Beta B), and a switch can't express three states without losing one. */
  triState?: boolean
  /** Unique switch id per surface — the matcher dialog and the series editor may both be mounted. */
  switchId?: string
}

/** Details tab body: rating/GTIN, the B&W control (switch or tri-state), and the long-text fields. */
export function ComicInfoDetailsFields({ fields, setField, blackAndWhite, setBlackAndWhite, triState = false, switchId = "ci-bw" }: DetailsProps) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Community Rating</Label>
          <Input type="number" min={0} max={5} step={0.1} value={fields.communityRating || ""}
            onChange={e => setField("communityRating")(e.target.value)} placeholder="0.0 - 5.0" className="bg-background border-border h-9" />
        </div>
        <TextField label="GTIN" value={fields.gtin || ""} onChange={setField("gtin")} placeholder="ISBN / ISSN / EAN" />
      </div>

      {triState ? (
        <div className="flex items-center gap-3 bg-muted/40 p-2.5 rounded-lg border border-border">
          <Label className="text-xs">Black and White</Label>
          <div className="flex rounded-md border border-border overflow-hidden ml-auto" role="group" aria-label="Black and White">
            {([["Unknown", null], ["Yes", true], ["No", false]] as [string, boolean | null][]).map(([label, val]) => (
              <button
                key={label}
                type="button"
                aria-pressed={blackAndWhite === val}
                onClick={() => setBlackAndWhite(val)}
                className={`px-3 h-8 text-xs font-semibold transition-colors ${blackAndWhite === val ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 bg-muted/40 p-2.5 rounded-lg border border-border">
          <Switch id={switchId} checked={blackAndWhite === true} onCheckedChange={v => setBlackAndWhite(v)} />
          <Label htmlFor={switchId} className="cursor-pointer text-xs">Black and White</Label>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label className="text-xs">Notes</Label>
        <Textarea value={fields.notes || ""} onChange={e => setField("notes")(e.target.value)} rows={3} className="bg-background border-border" />
      </div>
      <TextField label="Scan Information" value={fields.scanInformation || ""} onChange={setField("scanInformation")} />
      <div className="grid gap-1.5">
        <Label className="text-xs">Review</Label>
        <Textarea value={fields.review || ""} onChange={e => setField("review")(e.target.value)} rows={3} className="bg-background border-border" />
      </div>
    </>
  )
}
