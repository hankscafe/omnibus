// src/components/attach-local-collected-dialog.tsx
//
// The Smart Matcher's door for a trade ComicVine has no volume for (field report by
// robotshavehearts2: hand-curated TPBs the provider simply doesn't have). Pick the series it
// collects, name it, and it goes under that series as a LOCAL collected edition: its files move
// into the series' folder under their own names, its rows become the shelf's books, and what each
// book covers can be set on the series page. No provider lane, no sync — just yours.
//
// #257: opened on a loose FILE, it takes the edition's other books too — every loose file in the
// drop folder is listed, the ones with the same title ticked, each with its volume number (from the
// filename) and what it covers (typed, or filled evenly per book). The series may be picked from the
// provider instead of the library: it is created without a file of its own, and its sync brings the
// description and credits. The books are named after the edition so a rescan still finds them.
"use client"

import { useEffect, useRef, useState } from "react";
import { BookMarked, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { isSameIssue } from "@/lib/utils/issue-parser";
import { seriesQueryFromName } from "@/lib/utils/smart-match-search";
import {
    bookNumberFromFile, collectedFormatFromName, distinctEditionName, editionNameClashesWithSeries, editionNameFromFile, editionShelfTitle,
    evenCoverage, suggestIssuesPerBook, type CollectedFormat,
} from "@/lib/utils/collected-edition";

export interface LocalAttachItem {
    id?: string;
    name?: string;
    folderPath: string;
    isRawFile?: boolean;
}

/** The edition's name as the folder or file suggests it: no extension, no trailing "(year)". */
export function localNameFromItem(item: { name?: string; isRawFile?: boolean }): string {
    let n = (item.name || '').trim();
    if (item.isRawFile) n = n.replace(/\.[^/.]+$/, '');
    return n.replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

/** A loose file's name as the disk spells it — the list's `name` has its extension stripped. */
const fileNameOf = (item: LocalAttachItem) => item.folderPath.replace(/\\/g, '/').split('/').pop() || item.name || '';
const editionKey = (fileName: string) => editionNameFromFile(fileName).toLowerCase();
const BOOK_NUMBER = /^-?\d+(?:\.\d+)?[a-zA-Z]?$/;

type PickedSeries =
    | { from: 'library'; id: string; name: string; year: number | null }
    | { from: 'provider'; metadataSource: string; metadataId: string; name: string; year: number | null; publisher: string | null; count: number | null };

interface Book { path: string; fileName: string; checked: boolean; number: string; covers: string }

interface AttachLocalCollectedDialogProps {
    open: boolean;
    item: LocalAttachItem | null;
    /** #257: every loose file in the drop folder, so the edition's other books can be picked too. */
    candidates?: LocalAttachItem[];
    /** The provider a series may be picked from (the Smart Matcher's current source). */
    provider?: string;
    onClose: () => void;
    onDone: (result: any) => void;
}

export function AttachLocalCollectedDialog({ open, item, candidates, provider = 'COMICVINE', onClose, onDone }: AttachLocalCollectedDialogProps) {
    const { toast } = useToast();
    const [source, setSource] = useState<'library' | 'provider'>('library');
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<Array<{ id: string; name: string; year: number | null }>>([]);
    const [providerQuery, setProviderQuery] = useState("");
    const [providerResults, setProviderResults] = useState<any[]>([]);
    const [providerSearching, setProviderSearching] = useState(false);
    const [selected, setSelected] = useState<PickedSeries | null>(null);
    const [name, setName] = useState("");
    // #257: picked books form an edition of a TYPE — its name is "{Series} {Type}" unless the admin
    // writes one of their own (an "Epic Collection", a "Compendium").
    const [editionType, setEditionType] = useState<CollectedFormat>('TPB');
    // The type follows the series once one is picked ("Absolute Batman v01" is a TPB of Absolute
    // Batman, not an Absolute hardcover) — until the admin picks a type by hand.
    const [typeTouched, setTypeTouched] = useState(false);
    const [ownTitle, setOwnTitle] = useState("");
    const [customName, setCustomName] = useState(false);
    const [books, setBooks] = useState<Book[]>([]);
    const [perBook, setPerBook] = useState("");
    const [coverFromBook, setCoverFromBook] = useState(false);
    const [busy, setBusy] = useState(false);

    const providerLabel = provider === 'METRON' ? 'Metron' : 'ComicVine';
    const pickingFiles = !!item?.isRawFile;
    // Read when the dialog opens, not tracked: the page hands a fresh array every render.
    const candidatesRef = useRef(candidates);
    candidatesRef.current = candidates;

    useEffect(() => {
        if (!open) return;
        setSource('library'); setSearch(""); setResults([]); setProviderResults([]); setSelected(null); setBusy(false); setPerBook(""); setCoverFromBook(false);
        setCustomName(false); setEditionType('TPB'); setTypeTouched(false); setOwnTitle("");
        if (!item) { setName(""); setBooks([]); setProviderQuery(""); return; }
        if (!item.isRawFile) { setName(localNameFromItem(item)); setBooks([]); setProviderQuery(""); return; }

        const own = fileNameOf(item);
        setName(editionNameFromFile(own));
        // The type the files' own title says ("… Omnibus v01" is an omnibus), TPB otherwise.
        setOwnTitle(editionNameFromFile(own));
        setEditionType(collectedFormatFromName(editionNameFromFile(own)));
        // The edition's title without its edition words: "Captain America Omnibus v01" searches "Captain America".
        setProviderQuery(seriesQueryFromName(editionNameFromFile(own)).query);
        // The opened file, then the rest of the drop folder: the same title ticked and first.
        const loose = [item, ...(candidatesRef.current || []).filter(c => c.isRawFile && c.folderPath !== item.folderPath)];
        const key = editionKey(own);
        setBooks(loose
            .map(c => {
                const fileName = fileNameOf(c);
                return { path: c.folderPath, fileName, checked: c === item || editionKey(fileName) === key, number: bookNumberFromFile(fileName), covers: '' };
            })
            .sort((a, b) => Number(b.checked) - Number(a.checked) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true })));
    }, [open, item]);

    // Library search, debounced — the same call the series page's Move dialog makes.
    useEffect(() => {
        const q = search.trim();
        if (q.length < 2) { setResults([]); return; }
        const t = setTimeout(async () => {
            try {
                const res = await fetch(`/api/library?q=${encodeURIComponent(q)}&type=TITLE&limit=15`, { cache: 'no-store' });
                const data = await res.json();
                setResults((data.series || []).map((s: any) => ({ id: s.id, name: s.name, year: s.year ?? null })));
            } catch { setResults([]); }
        }, 300);
        return () => clearTimeout(t);
    }, [search]);

    // Provider search on demand, not per keystroke: every query costs the provider's rate limit.
    const searchProvider = async () => {
        const q = providerQuery.trim();
        if (q.length < 2) return;
        setProviderSearching(true);
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&provider=${provider}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Search failed');
            setProviderResults(data.results || []);
            if (!data.results?.length) toast({ title: "No results", description: `No series found on ${providerLabel} for "${q}".` });
        } catch (e: any) {
            setProviderResults([]);
            toast({ title: "Search failed", description: e?.message || 'Unknown error', variant: "destructive" });
        } finally {
            setProviderSearching(false);
        }
    };

    const pickProvider = (r: any) => {
        const count = Number(r.count) || null;
        setSelected({
            from: 'provider', metadataSource: r.metadataSource || provider, metadataId: String(r.id), name: r.name,
            year: r.year ? parseInt(String(r.year), 10) || null : null, publisher: r.publisher || null, count,
        });
        // A run that splits evenly over the picked books suggests how many issues each one covers.
        const highest = Math.max(0, ...books.filter(b => b.checked && /^\d+$/.test(b.number)).map(b => parseInt(b.number, 10)));
        const suggestion = suggestIssuesPerBook(count, highest);
        if (suggestion) setPerBook(String(suggestion));
        // A series picked from the provider is usually new to the library: offer the trade's own art.
        setCoverFromBook(true);
        followSeriesType(r.name);
    };

    const followSeriesType = (seriesName: string) => {
        if (pickingFiles && !typeTouched) setEditionType(collectedFormatFromName(ownTitle, seriesName));
    };

    const updateBook = (path: string, patch: Partial<Book>) => setBooks(prev => prev.map(b => (b.path === path ? { ...b, ...patch } : b)));

    const fillCovers = () => {
        const n = parseInt(perBook, 10);
        setBooks(prev => prev.map(b => (b.checked ? { ...b, covers: evenCoverage(b.number.trim(), n) ?? b.covers } : b)));
    };

    const autoName = selected ? `${selected.name.trim()} ${editionType}` : '';
    const trimmed = pickingFiles && !customName ? autoName : name.trim();
    const picked = books.filter(b => b.checked);
    const clash = pickingFiles && !!selected && editionNameClashesWithSeries(trimmed, selected.name);
    const bookProblem = ((): string | null => {
        if (!pickingFiles) return null;
        if (picked.length === 0) return 'Tick at least one book.';
        if (picked.some(b => !BOOK_NUMBER.test(b.number.trim()))) return 'Every ticked book needs a volume number.';
        for (let i = 0; i < picked.length; i++) {
            for (let j = i + 1; j < picked.length; j++) {
                if (isSameIssue(picked[i].number.trim(), picked[j].number.trim())) return `Two books are both Vol. ${picked[i].number.trim()}.`;
            }
        }
        return null;
    })();
    const canAttach = !!item && !!selected && trimmed.length > 0 && !clash && !bookProblem && !busy;

    const attach = async () => {
        if (!item || !selected || !trimmed) return;
        setBusy(true);
        try {
            const owner = selected.from === 'library'
                ? { seriesId: selected.id }
                : { parent: { metadataSource: selected.metadataSource, metadataId: selected.metadataId, name: selected.name, year: selected.year, publisher: selected.publisher } };
            const payload = pickingFiles
                ? {
                    ...owner, metadataSource: 'LOCAL', kind: 'COLLECTED', name: trimmed, coverFromBook,
                    files: picked.map(b => ({ path: b.path, number: b.number.trim(), coversIssues: b.covers.trim() })),
                }
                : { ...owner, metadataSource: 'LOCAL', kind: 'COLLECTED', name: trimmed, sourcePath: item.folderPath };
            const res = await fetch('/api/library/series/attachments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                if (data.suggestedName) setName(data.suggestedName);
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const seriesName = data.series?.name || selected.name;
            // The series cover is set by the server, before the provider sync it queues (seriesCover).
            if (data.seriesCover === 'failed') {
                toast({ title: "The books are attached, but the series cover didn't change", description: "The first book has no readable first page.", variant: "destructive" });
            }
            const leftBehind = (data.conflicts ?? 0) + (data.failed ?? 0);
            toast({
                title: `Attached ${data.name || trimmed}`,
                description: `Now a collected edition of ${seriesName} — ${data.moved ?? 0} file(s) moved into its folder${data.conflicts > 0 ? `, ${data.conflicts} left in place (name already taken)` : ''}${data.failed > 0 ? `, ${data.failed} left in place (error — see the logs)` : ''}.${data.series?.created ? ' The series was added to your library; its details are loading from the provider.' : ''}${data.seriesCover === 'book' ? " Its cover is now the first book's own." : ''}${pickingFiles ? '' : ' Set what each book covers on the series page.'}`,
                variant: leftBehind > 0 ? "destructive" : undefined,
            });
            onDone(data);
        } catch (e: any) {
            toast({ title: "Couldn't attach it", description: e?.message || 'Unknown error', variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    const selectedLabel = selected ? `${selected.name}${selected.year ? ` (${selected.year})` : ''}` : '';

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
            <DialogContent className={cn("bg-background border-border", pickingFiles ? "sm:max-w-3xl" : "sm:max-w-lg")}>
                <DialogHeader>
                    <DialogTitle>Attach to a series as a collected edition</DialogTitle>
                    <DialogDescription>
                        {pickingFiles
                            ? <>For trades or omnibuses the provider has no volume for. They go under the series they collect, on its collected-editions shelf, each as a numbered book. The series can come from your library or from {providerLabel}. File formats never change.</>
                            : <>For a trade or omnibus the provider has no volume for. It goes under the series it collects — files moved into that series&apos; folder under their own names, no provider link — and what each book covers can be set on the series page.</>}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2 max-h-[65vh] overflow-y-auto pr-1">
                    <div>
                        <Label htmlFor="local-attach-series" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">The series it collects</Label>
                        {pickingFiles && (
                            <div className="flex gap-2 mt-1" role="group" aria-label="Where to find the series">
                                <Button type="button" size="sm" variant={source === 'library' ? 'default' : 'outline'} aria-pressed={source === 'library'} disabled={busy}
                                    onClick={() => { setSource('library'); setSelected(null); }}>Your library</Button>
                                <Button type="button" size="sm" variant={source === 'provider' ? 'default' : 'outline'} aria-pressed={source === 'provider'} disabled={busy}
                                    onClick={() => { setSource('provider'); setSelected(null); }}>{providerLabel}</Button>
                            </div>
                        )}
                        {source === 'library' ? (
                            <div className="relative mt-2">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <Input
                                    id="local-attach-series"
                                    aria-label="Search your library for the series it collects"
                                    value={search}
                                    onChange={(e) => { setSearch(e.target.value); setSelected(null); }}
                                    placeholder="Search your library by title…"
                                    disabled={busy}
                                    className="pl-9 bg-muted/50 border-border"
                                />
                            </div>
                        ) : (
                            <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); searchProvider(); }}>
                                <Input
                                    id="local-attach-series"
                                    aria-label={`Search ${providerLabel} for the series it collects`}
                                    value={providerQuery}
                                    onChange={(e) => { setProviderQuery(e.target.value); setSelected(null); }}
                                    placeholder={`Search ${providerLabel} by title…`}
                                    disabled={busy}
                                    className="bg-muted/50 border-border"
                                />
                                <Button type="submit" variant="outline" disabled={busy || providerSearching || providerQuery.trim().length < 2} className="border-border">
                                    {providerSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}<span className="sr-only">Search</span>
                                </Button>
                            </form>
                        )}
                        {selected ? (
                            <p className="text-xs text-muted-foreground mt-2">
                                Selected: <span className="font-bold text-foreground">{selectedLabel}</span>
                                {selected.from === 'provider' && <> · {selected.publisher || 'Unknown publisher'} · {providerLabel}{selected.count ? ` · ${selected.count} issues` : ''}</>}
                                <button type="button" className="ml-2 underline" onClick={() => setSelected(null)} disabled={busy}>change</button>
                            </p>
                        ) : source === 'library' && results.length > 0 ? (
                            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                                {results.map((s) => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        onClick={() => { setSelected({ from: 'library', ...s }); setCoverFromBook(false); followSeriesType(s.name); }}
                                        className={cn("w-full text-left px-3 py-2 text-sm transition-colors hover:bg-muted")}
                                    >
                                        {s.name}{s.year ? ` (${s.year})` : ''}
                                    </button>
                                ))}
                            </div>
                        ) : source === 'provider' && providerResults.length > 0 ? (
                            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                                {providerResults.map((r) => (
                                    <button
                                        key={`${r.metadataSource || provider}_${r.id}`}
                                        type="button"
                                        onClick={() => pickProvider(r)}
                                        className="w-full text-left px-3 py-2 text-sm transition-colors hover:bg-muted"
                                    >
                                        <span className="font-semibold">{r.name}{r.year ? ` (${r.year})` : ''}</span>
                                        <span className="text-muted-foreground"> · {r.publisher || 'Unknown publisher'}{r.count ? ` · ${r.count} issues` : ''}</span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    {pickingFiles ? (
                        <div>
                            <Label htmlFor="local-attach-type" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Edition</Label>
                            <div className="flex flex-wrap items-center gap-3 mt-1">
                                <select
                                    id="local-attach-type"
                                    aria-label="Edition type"
                                    value={editionType}
                                    onChange={(e) => { setEditionType(e.target.value as CollectedFormat); setTypeTouched(true); }}
                                    disabled={busy || customName}
                                    className="h-9 rounded-md border border-border bg-muted/50 px-2 text-sm text-foreground"
                                >
                                    <option value="TPB">TPB — trade paperback</option>
                                    <option value="HC">HC — hardcover / deluxe</option>
                                    <option value="Omnibus">Omnibus</option>
                                    <option value="GN">GN — graphic novel</option>
                                </select>
                                <label className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={customName} disabled={busy}
                                        onChange={(e) => setCustomName(e.target.checked)} />
                                    Custom edition name
                                </label>
                            </div>
                            {customName && (
                                <>
                                    <Label htmlFor="local-attach-name" className="sr-only">Name of the collected edition</Label>
                                    <Input
                                        id="local-attach-name"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder="e.g. Ghost Rider Epic Collection"
                                        disabled={busy}
                                        className="mt-2 bg-muted/50 border-border"
                                    />
                                </>
                            )}
                            {clash && selected ? (
                                <p className="text-[11px] text-destructive mt-1">
                                    That&apos;s the series&apos; own name, so a rescan couldn&apos;t tell these books from its issues.{' '}
                                    <button type="button" className="underline font-semibold" onClick={() => setName(distinctEditionName(trimmed, selected.name))}>
                                        Use &quot;{distinctEditionName(trimmed, selected.name)}&quot;
                                    </button>
                                </p>
                            ) : selected && trimmed ? (
                                <p className="text-[11px] text-muted-foreground mt-1">
                                    Its own shelf on {selected.name}: <span className="font-bold text-foreground" data-testid="collected-shelf-title">{editionShelfTitle(trimmed, selected.name)}</span>
                                    {' '}· type <span className="font-bold text-foreground" data-testid="collected-format">{collectedFormatFromName(trimmed, selected.name)}</span>
                                    {' '}· edition &quot;<span data-testid="edition-name">{trimmed}</span>&quot;. The books are named after the edition (&quot;{trimmed} Vol. 001&quot;) unless their own names already say it — that is how a rescan finds them again.
                                </p>
                            ) : (
                                <p className="text-[11px] text-muted-foreground mt-1">The books go on their own shelf of the series, under the run&apos;s issues; pick the series to see it.</p>
                            )}
                        </div>
                    ) : (
                        <div>
                            <Label htmlFor="local-attach-name" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name of the collected edition</Label>
                            <Input
                                id="local-attach-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. Saga Compendium One"
                                disabled={busy}
                                className="mt-1 bg-muted/50 border-border"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">The files keep their names — that name is what ties them to this edition, so keep it as the files spell it.</p>
                        </div>
                    )}

                    {pickingFiles && (
                        <div>
                            <div className="flex flex-wrap items-end justify-between gap-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Books ({picked.length} ticked)</Label>
                                <div className="flex items-center gap-2">
                                    <Label htmlFor="local-attach-per-book" className="text-[11px] text-muted-foreground">Issues per book</Label>
                                    <Input id="local-attach-per-book" type="number" min={1} value={perBook} onChange={(e) => setPerBook(e.target.value)} disabled={busy} className="h-8 w-20 bg-muted/50 border-border" />
                                    <Button type="button" size="sm" variant="outline" className="h-8 border-border" disabled={busy || !(parseInt(perBook, 10) >= 1)} onClick={fillCovers}>Fill Covers</Button>
                                </div>
                            </div>
                            <div className="mt-2 rounded-lg border border-border divide-y divide-border max-h-72 overflow-y-auto">
                                {books.map((b) => (
                                    <div key={b.path} className={cn("flex flex-wrap items-center gap-2 px-3 py-2 text-sm", !b.checked && "opacity-60")}>
                                        <input type="checkbox" className="h-4 w-4 accent-primary" aria-label={`Include ${b.fileName}`} checked={b.checked} disabled={busy}
                                            onChange={(e) => updateBook(b.path, { checked: e.target.checked })} />
                                        <span className="flex-1 min-w-[12rem] truncate" title={b.fileName}>{b.fileName}</span>
                                        {b.checked && (
                                            <>
                                                <span className="text-[11px] text-muted-foreground">Vol.</span>
                                                <Input aria-label={`Volume number for ${b.fileName}`} value={b.number} disabled={busy}
                                                    onChange={(e) => updateBook(b.path, { number: e.target.value })} className="h-8 w-16 bg-muted/50 border-border" />
                                                <span className="text-[11px] text-muted-foreground">Covers</span>
                                                <Input aria-label={`Covers for ${b.fileName}`} value={b.covers} placeholder="e.g. 1-4" disabled={busy}
                                                    onChange={(e) => updateBook(b.path, { covers: e.target.value })} className="h-8 w-24 bg-muted/50 border-border" />
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-1">
                                {bookProblem || 'Covers lists the issues a book reprints ("1-4, 6"); those issues then count as owned. "Fill Covers" assumes every book collects the same number of consecutive issues — check it against the books.'}
                            </p>
                            <label className="flex items-center gap-2 mt-3 text-sm">
                                <input type="checkbox" className="h-4 w-4 accent-primary" checked={coverFromBook} disabled={busy}
                                    onChange={(e) => setCoverFromBook(e.target.checked)} />
                                Use the first book&apos;s own cover as the series cover
                            </label>
                        </div>
                    )}
                </div>

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={onClose} disabled={busy} className="border-border">Cancel</Button>
                    <Button onClick={attach} disabled={!canAttach} className="bg-primary text-primary-foreground font-bold hover:bg-primary/90">
                        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <BookMarked className="w-4 h-4 mr-2" />} Attach as a collected edition
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
