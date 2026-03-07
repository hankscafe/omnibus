"use client"

import { useState, useEffect } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2, ShieldAlert, Ghost, FileQuestion, FileWarning, Trash2, CheckCircle2, Search, ArrowLeft, EyeOff } from "lucide-react"
import Link from "next/link"

export default function DiagnosticsPage() {
    // PROPER REACT WAY TO SET DOCUMENT TITLE
    useEffect(() => {
        document.title = "Omnibus - Diagnostics";
    }, []);

    const [activeTab, setActiveTab] = useState<'ghosts' | 'orphans' | 'integrity'>('ghosts');
    const [isScanning, setIsScanning] = useState(false);
    const [isResolving, setIsResolving] = useState(false);
    
    const [ghosts, setGhosts] = useState<any[] | null>(null);
    const [orphans, setOrphans] = useState<any[] | null>(null);
    const [corrupted, setCorrupted] = useState<any[] | null>(null);

    // Multi-select state for orphans
    const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(new Set());

    const { toast } = useToast();

    const runScan = async (type: 'scan-ghosts' | 'scan-orphans' | 'scan-integrity') => {
        setIsScanning(true);
        try {
            const res = await fetch('/api/admin/diagnostics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: type })
            });
            const data = await res.json();
            
            if (type === 'scan-ghosts') setGhosts(data.ghosts);
            if (type === 'scan-orphans') {
                setOrphans(data.orphans);
                setSelectedOrphans(new Set()); // Reset selection on new scan
            }
            if (type === 'scan-integrity') setCorrupted(data.corrupted);
            
            toast({ title: "Scan Complete" });
        } catch (e) {
            toast({ title: "Scan Failed", variant: "destructive" });
        } finally {
            setIsScanning(false);
        }
    };

    const resolveGhosts = async () => {
        if (!ghosts || ghosts.length === 0) return;
        setIsResolving(true);
        try {
            const seriesIds = ghosts.filter(g => g.type === 'SERIES').map(g => g.id);
            const issueIds = ghosts.filter(g => g.type === 'ISSUE').map(g => g.id);

            if (seriesIds.length > 0) await fetch('/api/admin/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete-ghosts', payload: { ids: seriesIds, type: 'SERIES' } }) });
            if (issueIds.length > 0) await fetch('/api/admin/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete-ghosts', payload: { ids: issueIds, type: 'ISSUE' } }) });
            
            toast({ title: "Ghosts Cleared", description: "Database has been scrubbed." });
            setGhosts([]);
        } finally { setIsResolving(false); }
    };

    const deleteOrphans = async () => {
        if (selectedOrphans.size === 0) return;
        setIsResolving(true);
        try {
            const paths = Array.from(selectedOrphans);
            await fetch('/api/admin/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete-orphans', payload: { paths } }) });
            toast({ title: "Orphans Deleted", description: "Physical files removed from disk." });
            setOrphans(prev => prev ? prev.filter(o => !selectedOrphans.has(o.path)) : null);
            setSelectedOrphans(new Set());
        } finally { setIsResolving(false); }
    };

    const ignoreOrphans = async () => {
        if (selectedOrphans.size === 0) return;
        setIsResolving(true);
        try {
            const paths = Array.from(selectedOrphans);
            await fetch('/api/admin/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'ignore-orphans', payload: { paths } }) });
            toast({ title: "Files Ignored", description: "These files will no longer appear in scans." });
            setOrphans(prev => prev ? prev.filter(o => !selectedOrphans.has(o.path)) : null);
            setSelectedOrphans(new Set());
        } finally { setIsResolving(false); }
    };

    return (
        <div className="container mx-auto max-w-5xl py-10 px-6">
            <div className="flex items-start gap-4 mb-8">
                <Button variant="ghost" size="icon" className="shrink-0 mt-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100" asChild>
                    <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
                </Button>
                <div>
                    <h1 className="text-3xl font-extrabold flex items-center gap-3 text-slate-900 dark:text-slate-100">
                        <ShieldAlert className="w-8 h-8 text-red-500" />
                        Library Diagnostics
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">
                        Detect broken links, wasted disk space, and corrupted archives.
                    </p>
                </div>
            </div>

            {/* TABS */}
            <div className="flex flex-wrap gap-2 mb-6 border-b dark:border-slate-800 pb-4">
                <Button variant={activeTab === 'ghosts' ? 'default' : 'ghost'} onClick={() => setActiveTab('ghosts')} className={activeTab === 'ghosts' ? 'bg-indigo-600 hover:bg-indigo-700' : ''}>
                    <Ghost className="w-4 h-4 mr-2" /> Ghost Records
                </Button>
                <Button variant={activeTab === 'orphans' ? 'default' : 'ghost'} onClick={() => setActiveTab('orphans')} className={activeTab === 'orphans' ? 'bg-orange-600 hover:bg-orange-700' : ''}>
                    <FileQuestion className="w-4 h-4 mr-2" /> Orphaned Files
                </Button>
                <Button variant={activeTab === 'integrity' ? 'default' : 'ghost'} onClick={() => setActiveTab('integrity')} className={activeTab === 'integrity' ? 'bg-red-600 hover:bg-red-700' : ''}>
                    <FileWarning className="w-4 h-4 mr-2" /> Archive Integrity
                </Button>
            </div>

            {/* CONTENT: GHOSTS */}
            {activeTab === 'ghosts' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex justify-between items-center bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-900 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-indigo-900 dark:text-indigo-300">Ghost Records</h3>
                            <p className="text-sm text-indigo-700 dark:text-indigo-400">Database entries that point to physical folders or files that no longer exist on your hard drive.</p>
                        </div>
                        <Button onClick={() => runScan('scan-ghosts')} disabled={isScanning} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />} Scan Database
                        </Button>
                    </div>

                    {ghosts && ghosts.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-slate-200 dark:border-slate-800"><CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" /><p className="font-bold">No ghosts found! Database is perfectly aligned.</p></div>
                    )}

                    {ghosts && ghosts.length > 0 && (
                        <Card className="border-red-200 dark:border-red-900/50">
                            <div className="flex justify-between items-center p-4 border-b border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10">
                                <span className="font-bold text-red-600 dark:text-red-400">Found {ghosts.length} Ghost Records</span>
                                <Button size="sm" variant="destructive" onClick={resolveGhosts} disabled={isResolving}>{isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Trash2 className="w-4 h-4 mr-2"/>} Purge from Database</Button>
                            </div>
                            <div className="divide-y dark:divide-slate-800 max-h-[500px] overflow-y-auto">
                                {ghosts.map((g, i) => (
                                    <div key={i} className="p-3 text-sm flex flex-col hover:bg-slate-50 dark:hover:bg-slate-900">
                                        <div className="flex items-center gap-2 font-bold"><Badge variant="outline" className="text-[10px]">{g.type}</Badge> {g.name}</div>
                                        <div className="text-xs text-muted-foreground font-mono truncate mt-1">{g.path}</div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                </div>
            )}

            {/* CONTENT: ORPHANS */}
            {activeTab === 'orphans' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex justify-between items-center bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-900 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-orange-900 dark:text-orange-300">Orphaned Files</h3>
                            <p className="text-sm text-orange-700 dark:text-orange-400">Physical comic files taking up space on your hard drive that are NOT linked in Omnibus.</p>
                        </div>
                        <Button onClick={() => runScan('scan-orphans')} disabled={isScanning} className="bg-orange-600 hover:bg-orange-700 text-white">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />} Scan Disks
                        </Button>
                    </div>

                    {orphans && orphans.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-slate-200 dark:border-slate-800"><CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" /><p className="font-bold">No orphaned files! Disk is perfectly clean.</p></div>
                    )}

                    {orphans && orphans.length > 0 && (
                        <Card className="border-orange-200 dark:border-orange-900/50">
                            <div className="flex flex-col sm:flex-row justify-between sm:items-center p-4 border-b border-orange-100 dark:border-orange-900/30 bg-orange-50/50 dark:bg-orange-900/10 gap-4">
                                <span className="font-bold text-orange-600 dark:text-orange-400">Found {orphans.length} Wasted Files</span>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button size="sm" variant="outline" onClick={() => {
                                        if (selectedOrphans.size === orphans.length) setSelectedOrphans(new Set());
                                        else setSelectedOrphans(new Set(orphans.map(o => o.path)));
                                    }}>
                                        {selectedOrphans.size === orphans.length ? "Deselect All" : "Select All"}
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={ignoreOrphans} disabled={selectedOrphans.size === 0 || isResolving} className="text-slate-600 dark:text-slate-300">
                                        {isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <EyeOff className="w-4 h-4 mr-2"/>} Ignore ({selectedOrphans.size})
                                    </Button>
                                    <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={deleteOrphans} disabled={selectedOrphans.size === 0 || isResolving}>
                                        {isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Trash2 className="w-4 h-4 mr-2"/>} Delete ({selectedOrphans.size})
                                    </Button>
                                </div>
                            </div>
                            <div className="divide-y dark:divide-slate-800 max-h-[500px] overflow-y-auto">
                                {orphans.map((o, i) => (
                                    <div key={i} className="p-3 text-sm flex items-start gap-3 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors">
                                        <div className="pt-0.5">
                                            <Checkbox 
                                                checked={selectedOrphans.has(o.path)}
                                                onCheckedChange={(checked) => {
                                                    const next = new Set(selectedOrphans);
                                                    if (checked) next.add(o.path);
                                                    else next.delete(o.path);
                                                    setSelectedOrphans(next);
                                                }}
                                            />
                                        </div>
                                        <div className="flex flex-col min-w-0 cursor-pointer" onClick={() => {
                                            const next = new Set(selectedOrphans);
                                            if (next.has(o.path)) next.delete(o.path); else next.add(o.path);
                                            setSelectedOrphans(next);
                                        }}>
                                            <div className="font-bold truncate">{o.name}</div>
                                            <div className="text-xs text-muted-foreground font-mono truncate mt-1">{o.path}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                </div>
            )}

            {/* CONTENT: INTEGRITY */}
            {activeTab === 'integrity' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex justify-between items-center bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-red-900 dark:text-red-300">Archive Integrity Checker</h3>
                            <p className="text-sm text-red-700 dark:text-red-400">Tests the internal headers of your files to find corrupted/incomplete downloads. <strong className="font-black">Warning: May take several minutes for massive libraries.</strong></p>
                        </div>
                        <Button onClick={() => runScan('scan-integrity')} disabled={isScanning} className="bg-red-600 hover:bg-red-700 text-white">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldAlert className="w-4 h-4 mr-2" />} Test Archives
                        </Button>
                    </div>

                    {corrupted && corrupted.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-slate-200 dark:border-slate-800"><CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" /><p className="font-bold">100% Integrity. No corrupted files detected!</p></div>
                    )}

                    {corrupted && corrupted.length > 0 && (
                        <Card className="border-red-200 dark:border-red-900/50">
                            <div className="p-4 border-b border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10">
                                <span className="font-bold text-red-600 dark:text-red-400">Found {corrupted.length} Corrupted Archives</span>
                            </div>
                            <div className="divide-y dark:divide-slate-800 max-h-[500px] overflow-y-auto">
                                {corrupted.map((c, i) => (
                                    <div key={i} className="p-3 text-sm flex flex-col hover:bg-slate-50 dark:hover:bg-slate-900">
                                        <div className="font-bold text-red-500">{c.name}</div>
                                        <div className="text-xs text-muted-foreground font-mono truncate mt-1">{c.path}</div>
                                        <div className="text-xs text-red-400 mt-1">{c.error}</div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                </div>
            )}
        </div>
    )
}