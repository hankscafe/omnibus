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

export default function AdminTrophies() {
    if (typeof document !== 'undefined') {
        document.title = "Omnibus - Trophies";
    }

    const [trophies, setTrophies] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [modalOpen, setModalOpen] = useState(false)
    const [editing, setEditing] = useState<any>({ name: "", description: "", actionType: "READ_COUNT", targetValue: "", iconBase64: null })
    const { toast } = useToast()

    const fetchTrophies = async () => {
        try {
            const res = await fetch('/api/admin/trophies')
            setTrophies(await res.json())
        } finally { setLoading(false) }
    }

    useEffect(() => { fetchTrophies() }, [])

    useEffect(() => {
        document.title = "Omnibus - Trophies"
    }, [loading]);

    const handleIconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onloadend = () => setEditing({ ...editing, iconBase64: reader.result, _previewUrl: reader.result });
        reader.readAsDataURL(file);
    }

    const handleSave = async () => {
        try {
            const res = await fetch('/api/admin/trophies', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editing)
            });
            if (res.ok) {
                toast({ title: "Trophy Saved" });
                setModalOpen(false);
                fetchTrophies();
            }
        } catch (e) { toast({ variant: "destructive", title: "Error" }); }
    }

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`/api/admin/trophies?id=${id}`, { method: 'DELETE' });
            if (res.ok) fetchTrophies();
        } catch (e) { toast({ variant: "destructive", title: "Error" }); }
    }

    if (loading) return (
        <div className="p-20 text-center">
            <title>Omnibus - Trophies</title>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
        </div>
    )

    return (
        <div className="container mx-auto py-10 px-6 max-w-5xl space-y-8">
            <title>Omnibus - Trophies</title>
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-4">
                    <Link href="/admin"><Button variant="ghost" size="icon"><ArrowLeft className="w-5 h-5" /></Button></Link>
                    <h1 className="text-3xl font-bold flex items-center gap-2"><Trophy className="w-8 h-8 text-yellow-500"/> Trophy Management</h1>
                </div>
                <Button onClick={() => { setEditing({ name: "", description: "", actionType: "READ_COUNT", targetValue: "", iconBase64: null }); setModalOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Create Trophy</Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {trophies.map(t => (
                    <Card key={t.id} className="shadow-sm relative overflow-hidden group">
                        <CardContent className="p-6 flex items-start gap-4">
                            <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-900 border dark:border-slate-800 flex items-center justify-center shrink-0">
                                {t.iconUrl ? <img src={t.iconUrl} className="w-10 h-10 object-contain" /> : <Trophy className="w-8 h-8 text-slate-400" />}
                            </div>
                            <div className="flex-1">
                                <h3 className="font-bold text-lg leading-tight">{t.name}</h3>
                                <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
                                <p className="text-[10px] font-mono mt-2 bg-slate-100 dark:bg-slate-800 w-fit px-2 py-0.5 rounded text-blue-600 dark:text-blue-400">
                                    {t.actionType} &ge; {t.targetValue}
                                </p>
                            </div>
                        </CardContent>
                        <div className="absolute top-2 right-2 flex opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" onClick={() => { setEditing(t); setModalOpen(true); }}><Edit className="w-4 h-4"/></Button>
                            <Button variant="ghost" size="icon" className="text-red-500" onClick={() => handleDelete(t.id)}><Trash2 className="w-4 h-4"/></Button>
                        </div>
                    </Card>
                ))}
            </div>

            <Dialog open={modalOpen} onOpenChange={setModalOpen}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader><DialogTitle>{editing.id ? "Edit Trophy" : "New Trophy"}</DialogTitle></DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="flex flex-col items-center justify-center gap-2">
                            <div className="w-20 h-20 rounded-full border-2 border-dashed flex items-center justify-center relative overflow-hidden bg-slate-50 dark:bg-slate-900">
                                {editing._previewUrl || editing.iconUrl ? <img src={editing._previewUrl || editing.iconUrl} className="object-contain w-14 h-14" /> : <Upload className="w-6 h-6 text-muted-foreground" />}
                                <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" accept="image/*" onChange={handleIconUpload} />
                            </div>
                            <span className="text-[10px] text-muted-foreground">Upload Icon (Optional)</span>
                        </div>
                        <div className="grid gap-2"><Label>Trophy Name</Label><Input value={editing.name} onChange={e => setEditing({...editing, name: e.target.value})} placeholder="e.g. Bronze Reader" /></div>
                        <div className="grid gap-2"><Label>Description</Label><Input value={editing.description} onChange={e => setEditing({...editing, description: e.target.value})} placeholder="e.g. Read your first 10 comics." /></div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label>Action Type</Label>
                                <Select value={editing.actionType} onValueChange={v => setEditing({...editing, actionType: v})}>
                                    <SelectTrigger><SelectValue/></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="READ_COUNT">Comics Read</SelectItem>
                                        <SelectItem value="REQUEST_COUNT">Comics Requested</SelectItem>
                                        <SelectItem value="PUBLISHER_COUNT">Publishers Explored</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-2"><Label>Target Milestone</Label><Input type="number" value={editing.targetValue} onChange={e => setEditing({...editing, targetValue: e.target.value})} placeholder="e.g. 10" /></div>
                        </div>
                    </div>
                    <DialogFooter><Button onClick={handleSave}>Save Trophy</Button></DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}