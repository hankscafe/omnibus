// src/components/attach-local-collected-dialog.tsx
//
// The Smart Matcher's door for a trade ComicVine has no volume for (field report by
// robotshavehearts2: hand-curated TPBs the provider simply doesn't have). Pick the series it
// collects, name it, and it goes under that series as a LOCAL collected edition: its files move
// into the series' folder under their own names, its rows become the shelf's books, and what each
// book covers can be set on the series page. No provider lane, no sync — just yours.
"use client"

import { useEffect, useState } from "react";
import { BookMarked, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { errorMessageOr } from '@/lib/utils/error';
import type { LibrarySearchReply } from '@/types/api/library';
import type { LocalCollectedAttached } from '@/types/api/attachments';

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

interface AttachLocalCollectedDialogProps {
    open: boolean;
    item: LocalAttachItem | null;
    onClose: () => void;
    /** After a successful attach, with what it answered. */
    onDone: (result: LocalCollectedAttached) => void;
}

export function AttachLocalCollectedDialog({ open, item, onClose, onDone }: AttachLocalCollectedDialogProps) {
    const { toast } = useToast();
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<Array<{ id: string; name: string; year: number | null }>>([]);
    const [selected, setSelected] = useState<{ id: string; name: string; year: number | null } | null>(null);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setSearch(""); setResults([]); setSelected(null); setBusy(false);
        setName(item ? localNameFromItem(item) : "");
    }, [open, item]);

    // Library search, debounced — the same call the series page's Move dialog makes.
    useEffect(() => {
        const q = search.trim();
        if (q.length < 2) { setResults([]); return; }
        const t = setTimeout(async () => {
            try {
                const res = await fetch(`/api/library?q=${encodeURIComponent(q)}&type=TITLE&limit=15`, { cache: 'no-store' });
                const data: LibrarySearchReply = await res.json();
                setResults((data.series || []).map((s) => ({ id: s.id, name: s.name, year: s.year ?? null })));
            } catch { setResults([]); }
        }, 300);
        return () => clearTimeout(t);
    }, [search]);

    const trimmed = name.trim();
    const canAttach = !!item && !!selected && trimmed.length > 0 && !busy;

    const attach = async () => {
        if (!item || !selected || !trimmed) return;
        setBusy(true);
        try {
            const res = await fetch('/api/library/series/attachments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seriesId: selected.id, metadataSource: 'LOCAL', kind: 'COLLECTED', name: trimmed, sourcePath: item.folderPath }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
            toast({
                title: `Attached ${data.name || trimmed}`,
                description: `Now a collected edition of ${selected.name} — ${data.moved ?? 0} file(s) moved into its folder${data.conflicts > 0 ? `, ${data.conflicts} left in place (name already taken)` : ''}. Set what each book covers on the series page.`,
                variant: data.conflicts > 0 ? "destructive" : undefined,
            });
            onDone(data);
        } catch (e) {
            toast({ title: "Couldn't attach it", description: errorMessageOr(e, 'Unknown error'), variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
            <DialogContent className="sm:max-w-lg bg-background border-border">
                <DialogHeader>
                    <DialogTitle>Attach to a series as a collected edition</DialogTitle>
                    <DialogDescription>
                        For a trade or omnibus the provider has no volume for. It goes under the series it collects — files moved into that series&apos; folder under their own names, no provider link — and what each book covers can be set on the series page.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div>
                        <Label htmlFor="local-attach-series" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">The series it collects</Label>
                        <div className="relative mt-1">
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
                        {selected ? (
                            <p className="text-xs text-muted-foreground mt-2">Selected: <span className="font-bold text-foreground">{selected.name}{selected.year ? ` (${selected.year})` : ''}</span></p>
                        ) : results.length > 0 ? (
                            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                                {results.map((s) => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        onClick={() => setSelected(s)}
                                        className={cn("w-full text-left px-3 py-2 text-sm transition-colors hover:bg-muted")}
                                    >
                                        {s.name}{s.year ? ` (${s.year})` : ''}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>

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
