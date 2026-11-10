"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Trophy, Plus, Edit, Trash2, ArrowLeft, Loader2, Upload } from "lucide-react"
import Link from "next/link"
import { useToast } from "@/components/ui/use-toast"
import type { TrophyEntry } from "@/types/api/admin"

// What the trophy dialog edits: a new trophy, or a saved one (it has an id). The target is the
// number input's text; an uploaded icon is a data URL (readAsDataURL).
type TrophyDraft = Omit<Partial<TrophyEntry>, 'name' | 'description' | 'actionType' | 'targetValue'> & {
    name: string; description: string; actionType: string; targetValue: string | number;
    iconBase64?: string | null; _previewUrl?: string | null;
}

export default function AdminTrophies() {
    if (typeof document !== 'undefined') {
        document.title = "Omnibus - Trophies";
    }

    const [trophies, setTrophies] = useState<TrophyEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [modalOpen, setModalOpen] = useState(false)
    const [editing, setEditing] = useState<TrophyDraft>({ name: "", description: "", actionType: "READ_COUNT", targetValue: "", iconBase64: null })
    const { toast } = useToast()

    // The handlers live at /api/trophies (admin-only). This page used to ask /api/admin/trophies, a
    // route that never existed, so the list was always empty and saves/deletes silently did nothing.
    const errorOf = async (res: Response, fallback: string) => {
        const body = await res.json().catch(() => null);
        return (body && typeof body.error === 'string' && body.error) || fallback;
    }

    const fetchTrophies = async () => {
        try {
            const res = await fetch('/api/trophies')
            const data = await res.json().catch(() => null)
            if (res.ok && Array.isArray(data)) setTrophies(data)
            else toast({ variant: "destructive", title: "Couldn't load trophies", description: data?.error || `HTTP ${res.status}` })
        } catch (e) {
            toast({ variant: "destructive", title: "Couldn't load trophies", description: "The server could not be reached." })
        } finally { setLoading(false) }
    }

    // Load once on mount; fetchTrophies reads only setters and the stable toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchTrophies() }, [])

    useEffect(() => {
        document.title = "Omnibus - Trophies"
    }, [loading]);

    const handleIconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onloadend = () => setEditing({ ...editing, iconBase64: reader.result as string, _previewUrl: reader.result as string });
        reader.readAsDataURL(file);
    }

    const handleSave = async () => {
        if (!String(editing.name ?? '').trim()) {
            toast({ variant: "destructive", title: "Missing name", description: "Give the trophy a name." });
            return;
        }
        if (!/^\d+$/.test(String(editing.targetValue ?? '').trim()) || Number(editing.targetValue) < 1) {
            toast({ variant: "destructive", title: "Invalid target", description: "The target milestone must be a whole number of 1 or more." });
            return;
        }
        try {
            const res = await fetch('/api/trophies', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editing)
            });
            if (res.ok) {
                toast({ title: "Trophy Saved" });
                setModalOpen(false);
                fetchTrophies();
            } else {
                toast({ variant: "destructive", title: "Save Failed", description: await errorOf(res, `HTTP ${res.status}`) });
            }
        } catch (e) { toast({ variant: "destructive", title: "Error", description: "The server could not be reached." }); }
    }

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`/api/trophies?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (res.ok) fetchTrophies();
            else toast({ variant: "destructive", title: "Delete Failed", description: await errorOf(res, `HTTP ${res.status}`) });
        } catch (e) { toast({ variant: "destructive", title: "Error", description: "The server could not be reached." }); }
    }

    if (loading) return (
        <div className="p-20 text-center bg-background transition-colors duration-300">
            <title>Omnibus - Trophies</title>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
        </div>
    )

    return (
        <div className="container mx-auto py-10 px-6 max-w-5xl space-y-8 transition-colors duration-300">
            <title>Omnibus - Trophies</title>
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-4">
                    <Link href="/admin">
                        <Button variant="ghost" size="icon" className="hover:bg-muted text-foreground">
                            <ArrowLeft className="w-5 h-5" />
                        </Button>
                    </Link>
                    <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">
                        <Trophy className="w-8 h-8 text-primary"/> Trophy Management
                    </h1>
                </div>
                <Button 
                    className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-md"
                    onClick={() => { setEditing({ name: "", description: "", actionType: "READ_COUNT", targetValue: "", iconBase64: null }); setModalOpen(true); }}
                >
                    <Plus className="w-4 h-4 mr-2" /> Create Trophy
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {trophies.map(t => (
                    <Card key={t.id} className="shadow-sm relative overflow-hidden group border-border bg-background transition-all hover:border-primary/50">
                        <CardContent className="p-6 flex items-start gap-4">
                            <div className="w-16 h-16 rounded-full bg-muted border border-border flex items-center justify-center shrink-0 shadow-inner">
                                {t.iconUrl ? <img src={t.iconUrl} alt={`${t.name} icon`} className="w-10 h-10 object-contain" /> : <Trophy className="w-8 h-8 text-muted-foreground/50" />}
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="font-bold text-lg leading-tight text-foreground truncate">{t.name}</h3>
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.description}</p>
                                <p className="text-[10px] font-mono mt-2 bg-primary/10 w-fit px-2 py-0.5 rounded text-primary font-bold">
                                    {t.actionType} &ge; {t.targetValue}
                                </p>
                            </div>
                        </CardContent>
                        <div className="absolute top-2 right-2 flex opacity-0 group-hover:opacity-100 transition-opacity gap-1">
                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-primary/10 text-primary" aria-label={`Edit trophy ${t.name}`} onClick={() => { setEditing(t); setModalOpen(true); }}><Edit className="w-4 h-4"/></Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" aria-label={`Delete trophy ${t.name}`} onClick={() => handleDelete(t.id)}><Trash2 className="w-4 h-4"/></Button>
                        </div>
                    </Card>
                ))}
            </div>

            <Dialog open={modalOpen} onOpenChange={setModalOpen}>
                <DialogContent className="sm:max-w-[425px] bg-background border-border rounded-xl">
                    <DialogHeader>
                        <DialogTitle className="text-foreground">{editing.id ? "Edit Trophy" : "New Trophy"}</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="flex flex-col items-center justify-center gap-2">
                            <div className="w-20 h-20 rounded-full border-2 border-dashed border-border flex items-center justify-center relative overflow-hidden bg-muted group cursor-pointer transition-colors hover:border-primary">
                                {editing._previewUrl || editing.iconUrl ? (
                                    <img src={(editing._previewUrl || editing.iconUrl) ?? undefined} alt="Trophy icon preview" className="object-contain w-14 h-14" />
                                ) : (
                                    <Upload className="w-6 h-6 text-muted-foreground group-hover:text-primary transition-colors" />
                                )}
                                <input type="file" aria-label="Upload trophy icon" className="absolute inset-0 opacity-0 cursor-pointer" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleIconUpload} />
                            </div>
                            <span className="text-[10px] text-muted-foreground font-medium">Upload Icon (Optional — PNG, JPEG, WebP or GIF)</span>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="trophy-name" className="text-foreground">Trophy Name</Label>
                            <Input id="trophy-name" value={editing.name} onChange={e => setEditing({...editing, name: e.target.value})} placeholder="e.g. Bronze Reader" className="bg-background border-border" />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="trophy-description" className="text-foreground">Description</Label>
                            <Input id="trophy-description" value={editing.description} onChange={e => setEditing({...editing, description: e.target.value})} placeholder="e.g. Read your first 10 comics." className="bg-background border-border" />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label className="text-foreground">Action Type</Label>
                                <Select value={editing.actionType} onValueChange={v => setEditing({...editing, actionType: v})}>
                                    <SelectTrigger className="bg-background border-border">
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent className="bg-popover border-border">
                                        <SelectItem value="READ_COUNT" className="focus:bg-primary/10 focus:text-primary">Comics Read</SelectItem>
                                        <SelectItem value="REQUEST_COUNT" className="focus:bg-primary/10 focus:text-primary">Comics Requested</SelectItem>
                                        <SelectItem value="PUBLISHER_COUNT" className="focus:bg-primary/10 focus:text-primary">Publishers Explored</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="trophy-target" className="text-foreground">Target Milestone</Label>
                                <Input id="trophy-target" type="number" min={1} step={1} value={editing.targetValue} onChange={e => setEditing({...editing, targetValue: e.target.value})} placeholder="e.g. 10" className="bg-background border-border" />
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button 
                            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-md"
                            onClick={handleSave}
                        >
                            Save Trophy
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}