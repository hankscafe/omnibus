// src/components/attached-volumes-manager.tsx
//
// #203 Phase 1 (concept by anacronismo): the surface for attached volumes — ANNUALS, and since the
// COLLECTED phase, trades and omnibuses too. Providers model both as separate volumes with no
// machine link back to the parent, so the link is made here by hand: search the provider the same
// way Smart Match does, or paste the volume id outright.
//
// One component, two kinds. The mechanism is identical (id-anchored lane, silent claim, honest
// summary); only the words and two behaviours differ, which is why the copy lives in KIND_COPY
// rather than in a forked component that would drift.
//
// Two facts this UI exists to make plain:
//   1. Attaching CLAIMS local annual files it recognises. The result line says exactly what
//      happened ("claimed 2 · created 2 · 1 left unattached") instead of leaving the user to guess.
//   2. Numbers inside an attached lane are the user's to set. Renumbering a one-off annual to slot
//      it chronologically never breaks the provider link — the lane pairs by id — so the panel says
//      so where the renumbering actually happens.
"use client"

import { useCallback, useEffect, useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { BookMarked, Link2, Loader2, Plus, RefreshCw, Search, Unlink } from "lucide-react"
import { cn } from "@/lib/utils"

export interface Attachment {
    id: string
    metadataSource: string
    volumeId: string
    kind: string
    name: string | null
    startYear: number | null
    issueCount: number
    ownedCount: number
    lastSyncedAt: string | null
}

interface AttachSummary {
    total: number
    claimed: number
    created: number
    updated: number
    unclaimed: number
}

/**
 * The line the attach dialog reports back. Deliberately plain: every number is something the user
 * can go and look at, and "left unattached" is stated even though it's the unflattering one — a
 * silent claim has to be an honest claim.
 */
export function summaryLine(s: AttachSummary, noun = "annual file"): string {
    const parts: string[] = []
    if (s.claimed > 0) parts.push(`claimed ${s.claimed} file${s.claimed === 1 ? "" : "s"} you already own`)
    if (s.created > 0) parts.push(`added ${s.created} missing ${s.created === 1 ? "entry" : "entries"}`)
    if (s.updated > 0) parts.push(`refreshed ${s.updated}`)
    if (parts.length === 0) parts.push("nothing changed")
    let line = `${s.total} issue${s.total === 1 ? "" : "s"} in this volume — ${parts.join(" · ")}.`
    if (s.unclaimed > 0) {
        line += ` ${s.unclaimed} ${noun}${s.unclaimed === 1 ? "" : "s"} here still belong${s.unclaimed === 1 ? "s" : ""} to no volume.`
    }
    return line
}

const PROVIDERS = ["COMICVINE", "METRON"] as const

type AttachKind = "ANNUAL" | "COLLECTED"

const KIND_COPY: Record<AttachKind, {
    title: string
    blurb: string
    attachCta: string
    dialogTitle: string
    dialogBlurb: (series: string) => string
    searchPlaceholder: string
    /** What the search box starts as. Annual volumes are named "<Series> Annual"; a collection is
     *  usually named after the series itself ("Batman Vol. 1: The Court of Owls"). */
    seedQuery: (series: string) => string
    unclaimedNoun: string
    numberingNote: string
    emptyWithFiles: (n: number) => string
}> = {
    ANNUAL: {
        title: "Annuals",
        blurb: "Annuals live in their own provider volume. Attach one and its issues join this series.",
        attachCta: "Attach annual volume",
        dialogTitle: "Attach an annual volume",
        dialogBlurb: series => `Find the annual's own volume on the provider. Its issues join ${series} as annuals, and any annual files you already own that match are claimed automatically.`,
        searchPlaceholder: "Search the provider for the annual volume",
        seedQuery: series => `${series} annual`,
        unclaimedNoun: "annual file",
        numberingNote: "Numbering is yours: renumber an annual in its editor to slot it chronologically and the provider link still holds — attached issues are matched by ID, never by number.",
        emptyWithFiles: n => `${n} annual file${n === 1 ? "" : "s"} here belong${n === 1 ? "s" : ""} to no volume yet. Attaching the annual's volume claims the ones it recognises — your files stay exactly where they are.`,
    },
    COLLECTED: {
        title: "Collected editions",
        blurb: "Trades and omnibuses are their own provider volumes. Attach them here and number them in reading order.",
        attachCta: "Attach collected edition",
        dialogTitle: "Attach a collected edition",
        dialogBlurb: series => `Find the trade or omnibus on the provider. It joins ${series} as a collected edition — kept out of the issue count, because a collection reprints issues you may already own.`,
        searchPlaceholder: "Search the provider for the collection",
        seedQuery: series => series,
        unclaimedNoun: "book",
        numberingNote: "Number them in the order you want to read them — that number is yours to set, it becomes the volume number in the filename, and the provider link holds regardless.",
        emptyWithFiles: () => "",
    },
}

export function AttachedVolumesManager({
    seriesId,
    seriesName,
    kind = "ANNUAL",
    defaultProvider,
    unattachedAnnuals = 0,
    onChanged,
}: {
    seriesId: string
    seriesName: string
    /** ANNUAL or COLLECTED — decides the copy, the search seed, and the absorb prompt. */
    kind?: AttachKind
    defaultProvider?: string | null
    /** Annual files on this series that belong to no volume — the reason to act, when there is one. */
    unattachedAnnuals?: number
    onChanged?: () => void
}) {
    const copy = KIND_COPY[kind]
    const { toast } = useToast()
    const [attachments, setAttachments] = useState<Attachment[]>([])
    const [isLoading, setIsLoading] = useState(true)

    const [dialogOpen, setDialogOpen] = useState(false)
    const [provider, setProvider] = useState<string>(defaultProvider === "METRON" ? "METRON" : "COMICVINE")
    const [query, setQuery] = useState("")
    const [results, setResults] = useState<any[]>([])
    const [isSearching, setIsSearching] = useState(false)
    const [hasSearched, setHasSearched] = useState(false)
    const [exactId, setExactId] = useState("")
    const [attachingId, setAttachingId] = useState<string | null>(null)

    const [busyId, setBusyId] = useState<string | null>(null)
    // #203 COLLECTED: the attached volume turned out to already live in the library as its own
    // series. The user decides what happens to it — we never move someone's files uninvited.
    const [absorbPrompt, setAbsorbPrompt] = useState<{ attachmentId: string; series: { id: string; name: string; issueCount: number } } | null>(null)
    const [isAbsorbing, setIsAbsorbing] = useState(false)
    const [detachTarget, setDetachTarget] = useState<Attachment | null>(null)
    const [dropSkeletons, setDropSkeletons] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/library/series/attachments?seriesId=${encodeURIComponent(seriesId)}`)
            const data = await res.json()
            if (res.ok) setAttachments((data.attachments || []).filter((a: Attachment) => (a.kind || 'ANNUAL') === kind))
        } catch {
            /* a failed list is not worth a toast — the panel just stays empty */
        } finally {
            setIsLoading(false)
        }
    }, [seriesId, kind])

    useEffect(() => { load() }, [load])

    const openDialog = () => {
        // Pre-seed the search the way the user would type it. Mylar guesses this name too; the
        // difference is that here a wrong guess is one click away from being corrected.
        setQuery(copy.seedQuery(seriesName))
        setResults([])
        setHasSearched(false)
        setExactId("")
        setDialogOpen(true)
    }

    const runSearch = async () => {
        if (query.trim().length < 2) return
        setIsSearching(true)
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&provider=${provider}`)
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "Search failed")
            setResults(data.results || [])
            setHasSearched(true)
        } catch (e: any) {
            toast({ title: "Search failed", description: e.message, variant: "destructive" })
        } finally {
            setIsSearching(false)
        }
    }

    const attach = async (volumeId: string, name?: string, startYear?: string | number) => {
        setAttachingId(volumeId)
        try {
            const res = await fetch(`/api/library/series/attachments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ seriesId, volumeId, metadataSource: provider, kind, name, startYear }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) throw new Error(data.error || "The import failed")

            toast({
                title: `Attached ${data.name || `volume ${volumeId}`}`,
                description: data.summary ? summaryLine(data.summary, copy.unclaimedNoun) : "Attached.",
            })
            setDialogOpen(false)
            if (data.existingSeries) {
                setAbsorbPrompt({ attachmentId: data.attachmentId, series: data.existingSeries })
            }
            await load()
            onChanged?.()
        } catch (e: any) {
            toast({ title: "Couldn't attach that volume", description: e.message, variant: "destructive" })
        } finally {
            setAttachingId(null)
        }
    }

    const refresh = async (a: Attachment) => {
        setBusyId(a.id)
        try {
            const res = await fetch(`/api/library/series/attachments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ seriesId, volumeId: a.volumeId, metadataSource: a.metadataSource, kind: a.kind }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) throw new Error(data.error || "The refresh failed")
            toast({ title: `Refreshed ${a.name || `volume ${a.volumeId}`}`, description: data.summary ? summaryLine(data.summary, copy.unclaimedNoun) : "Up to date." })
            // The standalone twin may have appeared since the attach (matched later, or the user
            // declined at the time) — a refresh is a fair moment to offer the move again.
            if (data.existingSeries) {
                setAbsorbPrompt({ attachmentId: a.id, series: data.existingSeries })
            }
            await load()
            onChanged?.()
        } catch (e: any) {
            toast({ title: "Refresh failed", description: e.message, variant: "destructive" })
        } finally {
            setBusyId(null)
        }
    }

    const absorb = async () => {
        if (!absorbPrompt) return
        setIsAbsorbing(true)
        try {
            const res = await fetch(`/api/library/series/attachments`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ attachmentId: absorbPrompt.attachmentId, sourceSeriesId: absorbPrompt.series.id }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) throw new Error(data.error || "The move failed")
            toast({
                title: "Moved under this series",
                description: `${data.moved} book${data.moved === 1 ? "" : "s"} now belong${data.moved === 1 ? "s" : ""} to ${seriesName}. Run Standardize Names to move the files into its folder.`,
            })
            setAbsorbPrompt(null)
            await load()
            onChanged?.()
        } catch (e: any) {
            toast({ title: "Couldn't move it", description: e.message, variant: "destructive" })
        } finally {
            setIsAbsorbing(false)
        }
    }

    const detach = async () => {
        if (!detachTarget) return
        setBusyId(detachTarget.id)
        try {
            const res = await fetch(`/api/library/series/attachments`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ attachmentId: detachTarget.id, deleteSkeletons: dropSkeletons }),
            })
            const data = await res.json()
            if (!res.ok || !data.success) throw new Error(data.error || "The detach failed")
            toast({
                title: "Detached",
                description: `${data.keptIssues} issue${data.keptIssues === 1 ? "" : "s"} kept${data.skeletonsDeleted ? `, ${data.skeletonsDeleted} missing ${data.skeletonsDeleted === 1 ? "entry" : "entries"} removed` : ""}. Your files were not touched.`,
            })
            setDetachTarget(null)
            setDropSkeletons(false)
            await load()
            onChanged?.()
        } catch (e: any) {
            toast({ title: "Detach failed", description: e.message, variant: "destructive" })
        } finally {
            setBusyId(null)
        }
    }

    if (isLoading) return null

    return (
        <div className="space-y-4 mb-8 bg-muted/30 border border-border rounded-xl p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <BookMarked className="w-6 h-6 text-primary" />
                    <div>
                        <h4 className="font-bold text-lg text-foreground">{copy.title}</h4>
                        <p className="text-xs text-muted-foreground">
                            {copy.blurb}
                        </p>
                    </div>
                </div>
                <Button size="sm" className="font-bold shrink-0" onClick={openDialog}>
                    <Plus className="w-4 h-4 mr-1" /> {copy.attachCta}
                </Button>
            </div>

            {attachments.length === 0 ? (
                // Only speak up when there's a reason to: a series with no annuals at all doesn't
                // need a paragraph about annuals on every visit.
                unattachedAnnuals > 0 && copy.emptyWithFiles(unattachedAnnuals) ? (
                    <p className="text-sm text-muted-foreground pt-1">{copy.emptyWithFiles(unattachedAnnuals)}</p>
                ) : null
            ) : (
                <div className="space-y-2 pt-1">
                    {attachments.map(a => (
                        <div
                            key={a.id}
                            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-background p-3 rounded-lg border border-border shadow-sm"
                        >
                            <div className="min-w-0">
                                <p className="font-bold text-sm text-foreground truncate">
                                    {a.name || `Volume ${a.volumeId}`}
                                    {a.startYear ? <span className="text-muted-foreground font-normal"> ({a.startYear})</span> : null}
                                </p>
                                <p className="text-xs text-muted-foreground font-mono">
                                    {a.metadataSource} {a.volumeId} · {a.ownedCount} of {a.issueCount} owned
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-8 px-3 text-xs font-bold"
                                    disabled={busyId === a.id}
                                    onClick={() => refresh(a)}
                                >
                                    {busyId === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <><RefreshCw className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Refresh</span></>}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 px-3 text-xs font-bold border-border"
                                    disabled={busyId === a.id}
                                    onClick={() => { setDetachTarget(a); setDropSkeletons(false) }}
                                >
                                    <Unlink className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Detach</span>
                                </Button>
                            </div>
                        </div>
                    ))}
                    <p className="text-xs text-muted-foreground pt-1">{copy.numberingNote}</p>
                </div>
            )}

            {/* --- ATTACH DIALOG (the Smart Matcher's search, pre-seeded for annuals) --- */}
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-[640px] bg-background border-border rounded-xl max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="text-foreground">{copy.dialogTitle}</DialogTitle>
                        <DialogDescription>
                            {copy.dialogBlurb(seriesName)}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            {PROVIDERS.map(p => (
                                <Button
                                    key={p}
                                    size="sm"
                                    variant={provider === p ? "secondary" : "ghost"}
                                    className={cn("h-8 px-3 text-xs font-bold", provider === p && "border border-border")}
                                    onClick={() => { setProvider(p); setResults([]); setHasSearched(false) }}
                                >
                                    {p === "COMICVINE" ? "ComicVine" : "Metron"}
                                </Button>
                            ))}
                        </div>

                        <div className="flex items-center gap-2">
                            <Input
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); runSearch() } }}
                                placeholder={copy.searchPlaceholder}
                                className="bg-background border-border"
                            />
                            <Button
                                aria-label="Search"
                                className="font-bold shrink-0"
                                onClick={runSearch}
                                disabled={isSearching || query.trim().length < 2}
                            >
                                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                            </Button>
                        </div>

                        {hasSearched && results.length === 0 && !isSearching && (
                            <p className="text-sm text-muted-foreground">
                                Nothing found. Annual volumes are often named just &quot;{seriesName} Annual&quot; — try a shorter
                                query, or paste the volume ID below.
                            </p>
                        )}

                        {results.length > 0 && (
                            <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                                {results.map((r: any) => (
                                    <div key={`${r.id}`} className="flex items-center gap-3 p-2 rounded-lg border border-border bg-muted/20">
                                        <div className="relative w-10 h-14 shrink-0 rounded overflow-hidden bg-muted">
                                            {r.image ? (
                                                <Image src={r.image} alt="" fill sizes="40px" className="object-cover" unoptimized />
                                            ) : null}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-bold text-foreground truncate">{r.name}</p>
                                            <p className="text-xs text-muted-foreground truncate">
                                                {[r.publisher, r.year].filter(Boolean).join(" · ")}
                                                <span className="font-mono"> · {r.id}</span>
                                            </p>
                                        </div>
                                        <Button
                                            size="sm"
                                            aria-label={`Attach ${r.name}`}
                                            className="h-8 px-3 text-xs font-bold shrink-0"
                                            disabled={attachingId !== null}
                                            onClick={() => attach(String(r.id), r.name, r.year)}
                                        >
                                            {attachingId === String(r.id) ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Link2 className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Attach</span></>}
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="border-t border-border pt-4 space-y-2">
                            <Label htmlFor="annual-exact-id" className="text-xs font-bold text-foreground">
                                Or attach by volume ID
                            </Label>
                            <div className="flex items-center gap-2">
                                <Input
                                    id="annual-exact-id"
                                    value={exactId}
                                    onChange={e => setExactId(e.target.value)}
                                    placeholder={provider === "COMICVINE" ? "e.g. 49197" : "Metron series id"}
                                    className="bg-background border-border font-mono"
                                />
                                <Button
                                    variant="secondary"
                                    className="font-bold shrink-0"
                                    disabled={!exactId.trim() || attachingId !== null}
                                    onClick={() => attach(exactId.trim())}
                                >
                                    {attachingId === exactId.trim() ? <Loader2 className="w-4 h-4 animate-spin" /> : "Attach"}
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                ComicVine volume IDs are the number after <span className="font-mono">4050-</span> in the volume&apos;s URL.
                            </p>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* --- ALREADY IN THE LIBRARY: move it here, or leave it standing (#203 COLLECTED) --- */}
            <Dialog
                open={absorbPrompt !== null}
                onOpenChange={open => { if (!open && !isAbsorbing) setAbsorbPrompt(null) }}
            >
                <DialogContent className="sm:max-w-[520px] bg-background border-border rounded-xl">
                    <DialogHeader>
                        <DialogTitle className="text-foreground">This volume is already in your library</DialogTitle>
                        <DialogDescription>
                            &quot;{absorbPrompt?.series.name}&quot; exists as its own series with{" "}
                            {absorbPrompt?.series.issueCount} book{absorbPrompt?.series.issueCount === 1 ? "" : "s"}.
                            You can move it under {seriesName} so everything sits in one place, or leave it where it is —
                            the attachment works either way.
                        </DialogDescription>
                    </DialogHeader>

                    <p className="text-xs text-muted-foreground leading-relaxed">
                        Moving keeps every file, along with reading progress and anything you edited. The files
                        themselves are relocated the next time you run Standardize Names on {seriesName}.
                    </p>

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            variant="outline"
                            className="border-border"
                            disabled={isAbsorbing}
                            onClick={() => setAbsorbPrompt(null)}
                        >
                            Leave it as its own series
                        </Button>
                        <Button className="font-bold" disabled={isAbsorbing} onClick={absorb}>
                            {isAbsorbing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Link2 className="w-4 h-4 mr-2" />}
                            Move it under {seriesName}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            {/* --- DETACH (its own dialog, because the skeleton sweep is a choice made HERE) --- */}
            <Dialog
                open={detachTarget !== null}
                onOpenChange={open => { if (!open && busyId === null) { setDetachTarget(null); setDropSkeletons(false) } }}
            >
                <DialogContent className="sm:max-w-[480px] bg-background border-border rounded-xl">
                    <DialogHeader>
                        <DialogTitle className="text-foreground">Detach this volume?</DialogTitle>
                        <DialogDescription>
                            The issues stay exactly as they are — files, numbers, and anything you edited. They simply
                            stop being linked to {detachTarget?.name || "this volume"}, and stop syncing with it.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex items-start gap-2 py-2">
                        <Checkbox
                            id="drop-skeletons"
                            checked={dropSkeletons}
                            onCheckedChange={v => setDropSkeletons(v === true)}
                        />
                        <Label htmlFor="drop-skeletons" className="text-xs text-muted-foreground leading-relaxed">
                            Also remove the missing-issue entries this volume added. Only entries with no file — nothing you
                            own is ever deleted here.
                        </Label>
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            className="border-border"
                            disabled={busyId !== null}
                            onClick={() => { setDetachTarget(null); setDropSkeletons(false) }}
                        >
                            Cancel
                        </Button>
                        <Button className="font-bold" disabled={busyId !== null} onClick={detach}>
                            {busyId !== null ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Unlink className="w-4 h-4 mr-2" />}
                            Detach
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
