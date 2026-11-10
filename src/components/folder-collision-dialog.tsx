// src/components/folder-collision-dialog.tsx
//
// A match would land in a folder another series already owns (field report by robotshavehearts2:
// a run and its collected editions share a name and a year, so they compute the same folder). Two
// series never share a folder, so the admin chooses: put the volume UNDER the series that owns
// the folder, as a collected edition — usually what a same-name-same-year collision is — or give
// it a folder name of its own. Nothing happens until they do.
"use client"

import { useEffect, useState } from "react";
import { BookMarked, FolderPlus, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FolderCollision } from "@/types/api/smart-match";

// The 409 body's `collision` (match-series builds it); its home is the route's payload types.
export type { FolderCollision };

export type CollisionResolution = { mode: 'attach' } | { mode: 'rename'; folderName: string };

interface FolderCollisionDialogProps {
    open: boolean;
    collision: FolderCollision | null;
    busy: boolean;
    onCancel: () => void;
    onResolve: (resolution: CollisionResolution) => void;
}

const basename = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p;
const dirname = (p: string) => { const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/'); parts.pop(); return parts.join('/') || '/'; };

export function FolderCollisionDialog({ open, collision, busy, onCancel, onResolve }: FolderCollisionDialogProps) {
    const [folderName, setFolderName] = useState(collision?.suggestedFolderName ?? '');
    useEffect(() => { setFolderName(collision?.suggestedFolderName ?? ''); }, [collision?.suggestedFolderName, open]);

    if (!collision) return null;
    const ownerLabel = collision.year ? `${collision.seriesName} (${collision.year})` : collision.seriesName;
    const trimmed = folderName.trim();

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
            <DialogContent className="sm:max-w-lg bg-background border-border">
                <DialogHeader>
                    <DialogTitle>This folder already belongs to another series</DialogTitle>
                    <DialogDescription>
                        &ldquo;{collision.volumeName}&rdquo; would be filed as <span className="font-mono text-foreground">{basename(collision.folderPath)}</span>, which already belongs to <strong className="text-foreground">{ownerLabel}</strong>. Two series can&apos;t share a folder. Publishers often give a run and its collected editions the same name and year — if this is that, put it under the series it collects.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <Button
                        variant="default"
                        disabled={busy}
                        onClick={() => onResolve({ mode: 'attach' })}
                        className="w-full h-auto py-3 justify-start text-left whitespace-normal bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                        {busy ? <Loader2 className="w-5 h-5 mr-3 shrink-0 animate-spin" /> : <BookMarked className="w-5 h-5 mr-3 shrink-0" />}
                        <span className="min-w-0">
                            <span className="block font-bold">Add it to {collision.seriesName} as a collected edition</span>
                            <span className="block text-xs opacity-80 font-normal">Its books join that series&apos; Collected Editions shelf, matched by ID, and the files move into its folder. What each book covers can be set there.</span>
                        </span>
                    </Button>

                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground/60 font-black">
                        <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
                    </div>

                    <div>
                        <Label htmlFor="collision-folder-name" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Folder name</Label>
                        <Input
                            id="collision-folder-name"
                            value={folderName}
                            onChange={(e) => setFolderName(e.target.value)}
                            disabled={busy}
                            className="mt-1 bg-muted/50 border-border"
                        />
                        <p className="text-[11px] text-muted-foreground mt-1">
                            A folder of its own inside <span className="font-mono">{dirname(collision.folderPath)}</span>. Something that says what it is — &ldquo;(TPB)&rdquo;, &ldquo;(Collected)&rdquo; — reads better than a number.
                        </p>
                        <Button
                            variant="outline"
                            disabled={busy || !trimmed}
                            onClick={() => onResolve({ mode: 'rename', folderName: trimmed })}
                            className="mt-2 w-full border-border"
                        >
                            <FolderPlus className="w-4 h-4 mr-2" /> Use this folder name
                        </Button>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
