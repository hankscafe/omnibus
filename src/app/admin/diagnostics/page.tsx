"use client"

import { useState, useEffect } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Loader2, ShieldAlert, Ghost, FileQuestion, FileWarning, Trash2, CheckCircle2, Search, ArrowLeft, EyeOff, Files, Star, AlertTriangle, RefreshCw } from "lucide-react"
import Link from "next/link"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"

// Stable key per duplicate group. seriesId + issue number identifies the group; the index keeps it
// unique even in the impossible event of a collision.
const groupKey = (g: any, idx: number) => `${g.seriesId}_${g.issueNumber}_${idx}`;
const DELETE_ALL = '__DELETE_ALL__';
// "Keep every copy" selection state — nothing in the group is deleted. The default for groups the
// detector flags as suspected metadata mispairs (issue #196: files 001 and 004 sharing one DB
// number are different comics, not duplicates — deleting either would remove a real issue).
const KEEP_ALL = '__KEEP_ALL__';

export default function DiagnosticsPage() {
    // PROPER REACT WAY TO SET DOCUMENT TITLE
    useEffect(() => {
        document.title = "Omnibus - Diagnostics";
    }, []);

    const [activeTab, setActiveTab] = useState<'ghosts' | 'orphans' | 'integrity' | 'duplicates'>('ghosts');
    const [isScanning, setIsScanning] = useState(false);
    const [isResolving, setIsResolving] = useState(false);
    
    const [ghosts, setGhosts] = useState<any[] | null>(null);
    const [orphans, setOrphans] = useState<any[] | null>(null);
    const [corrupted, setCorrupted] = useState<any[] | null>(null);

    // Multi-select state for orphans
    const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(new Set());

    const [duplicates, setDuplicates] = useState<any[] | null>(null);
    // Per-group keeper selection: groupKey -> the file id to KEEP (or DELETE_ALL to remove every copy).
    const [keepMap, setKeepMap] = useState<Record<string, string>>({});
    // Files queued for a confirmed deletion.
    const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; label: string } | null>(null);

    const { toast } = useToast();

    const runScan = async (type: 'scan-ghosts' | 'scan-orphans' | 'scan-integrity' | 'scan-duplicates') => {
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
            if (type === 'scan-duplicates') {
                const groups: any[] = data.duplicates || [];
                setDuplicates(groups);
                // Default keeper for each group is the largest file (usually the most complete copy).
                // Suspected mispairs default to keeping EVERY copy — the files are probably different
                // issues, so no copy may be pre-marked for deletion (issue #196).
                const km: Record<string, string> = {};
                groups.forEach((g, idx) => {
                    if (g.suspectedMispair) {
                        km[groupKey(g, idx)] = KEEP_ALL;
                        return;
                    }
                    const largest = [...g.files].sort((a: any, b: any) => (b.size || 0) - (a.size || 0))[0];
                    km[groupKey(g, idx)] = largest?.id ?? DELETE_ALL;
                });
                setKeepMap(km);
            }

            toast({ title: "Scan Complete" });
        } catch (e) {
            toast({ title: "Scan Failed", variant: "destructive" });
        } finally {
            setIsScanning(false);
        }
    };

    // Deep-link support: /admin/diagnostics?tab=duplicates (from the dashboard health alert) lands on
    // the right tab and kicks off the scan immediately. Read from the URL directly to avoid pulling in
    // useSearchParams (which would force a Suspense boundary on this client page).
    useEffect(() => {
        const tab = new URLSearchParams(window.location.search).get('tab');
        if (tab === 'duplicates' || tab === 'orphans' || tab === 'integrity' || tab === 'ghosts') {
            setActiveTab(tab);
            if (tab === 'duplicates') runScan('scan-duplicates');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Delete every copy the admin didn't mark "keep" for this group. DELETE_ALL removes them all;
    // KEEP_ALL deletes none (so "Resolve All" naturally skips suspected-mispair groups).
    const idsToDeleteFor = (group: any, key: string): string[] => {
        const keepId = keepMap[key];
        if (keepId === KEEP_ALL) return [];
        return group.files
            .filter((f: any) => keepId === DELETE_ALL || f.id !== keepId)
            .map((f: any) => f.id);
    };

    // One-click steer for suspected mispairs: queue a metadata re-sync for the series — the
    // number-anchored pairing re-links crossed records in place, which is the actual fix (the
    // resolver's delete would remove a real comic). Only offered when the series is provider-matched.
    const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
    const queueMetadataRefresh = async (group: any, key: string) => {
        setRefreshingKey(key);
        try {
            const res = await fetch('/api/library/refresh-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ metadataId: group.seriesMetadataId, metadataSource: group.seriesMetadataSource })
            });
            if (!res.ok) throw new Error();
            toast({ title: "Metadata refresh queued", description: `${group.seriesName} will re-pair in the background — run Find Duplicates again in a minute.` });
        } catch (e) {
            toast({ title: "Refresh failed to queue", variant: "destructive" });
        } finally {
            setRefreshingKey(null);
        }
    };

    const runDelete = async (ids: string[]) => {
        setIsResolving(true);
        try {
            await fetch('/api/admin/diagnostics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete-duplicates', payload: { idsToDelete: ids, deletePhysical: true } })
            });
            toast({ title: "Duplicates Removed", description: `${ids.length} file${ids.length > 1 ? 's' : ''} deleted from disk.` });
            await runScan('scan-duplicates');
        } catch (e) {
            toast({ title: "Deletion Failed", variant: "destructive" });
        } finally {
            setIsResolving(false);
            setPendingDelete(null);
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
        <div className="container mx-auto max-w-5xl py-10 px-6 transition-colors duration-300">
            <div className="flex items-start gap-4 mb-8">
                <Button variant="ghost" size="icon" className="shrink-0 mt-1 text-muted-foreground hover:bg-muted hover:text-foreground" asChild>
                    <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
                </Button>
                <div>
                    <h1 className="text-3xl font-extrabold flex items-center gap-3 text-foreground">
                        <ShieldAlert className="w-8 h-8 text-primary" />
                        Library Diagnostics
                    </h1>
                    <p className="text-muted-foreground mt-1">
                        Detect broken links, wasted disk space, and corrupted archives.
                    </p>
                </div>
            </div>

            {/* TABS */}
            <div className="flex flex-wrap gap-2 mb-6 border-b border-border pb-4">
                <Button 
                    variant={activeTab === 'ghosts' ? 'default' : 'ghost'} 
                    onClick={() => setActiveTab('ghosts')} 
                    className={activeTab === 'ghosts' ? 'bg-primary hover:bg-primary/90 text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}
                >
                    <Ghost className="w-4 h-4 mr-2" /> Ghost Records
                </Button>
                <Button 
                    variant={activeTab === 'orphans' ? 'default' : 'ghost'} 
                    onClick={() => setActiveTab('orphans')} 
                    className={activeTab === 'orphans' ? 'bg-primary hover:bg-primary/90 text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}
                >
                    <FileQuestion className="w-4 h-4 mr-2" /> Orphaned Files
                </Button>
                <Button
                    variant={activeTab === 'integrity' ? 'default' : 'ghost'}
                    onClick={() => setActiveTab('integrity')}
                    className={activeTab === 'integrity' ? 'bg-primary hover:bg-primary/90 text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}
                >
                    <FileWarning className="w-4 h-4 mr-2" /> Archive Integrity
                </Button>
                <Button
                    variant={activeTab === 'duplicates' ? 'default' : 'ghost'}
                    onClick={() => setActiveTab('duplicates')}
                    className={activeTab === 'duplicates' ? 'bg-primary hover:bg-primary/90 text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}
                >
                    <Files className="w-4 h-4 mr-2" /> Duplicates
                </Button>
            </div>

            {/* CONTENT: GHOSTS */}
            {activeTab === 'ghosts' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex justify-between items-center bg-primary/10 border border-primary/20 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-primary">Ghost Records</h3>
                            <p className="text-sm text-primary/80">Database entries that point to physical folders or files that no longer exist on your hard drive.</p>
                        </div>
                        <Button onClick={() => runScan('scan-ghosts')} disabled={isScanning} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />} Scan Database
                        </Button>
                    </div>

                    {ghosts && ghosts.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-border bg-muted/30">
                            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
                            <p className="font-bold text-foreground">No ghosts found! Database is perfectly aligned.</p>
                        </div>
                    )}

                    {ghosts && ghosts.length > 0 && (
                        <Card className="border-primary/20 bg-background overflow-hidden">
                            <div className="flex justify-between items-center p-4 border-b border-border bg-muted/50">
                                <span className="font-bold text-primary">Found {ghosts.length} Ghost Records</span>
                                <Button size="sm" variant="destructive" onClick={resolveGhosts} disabled={isResolving}>
                                    {isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Trash2 className="w-4 h-4 mr-2"/>} 
                                    Purge from Database
                                </Button>
                            </div>
                            <div className="divide-y border-border max-h-[500px] overflow-y-auto">
                                {ghosts.map((g, i) => (
                                    <div key={i} className="p-3 text-sm flex flex-col hover:bg-muted transition-colors">
                                        <div className="flex items-center gap-2 font-bold text-foreground">
                                            <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">{g.type}</Badge> 
                                            {g.name}
                                        </div>
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
                    <div className="flex justify-between items-center bg-primary/10 border border-primary/20 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-primary">Orphaned Files</h3>
                            <p className="text-sm text-primary/80">Physical comic files taking up space on your hard drive that are NOT linked in Omnibus.</p>
                        </div>
                        <Button onClick={() => runScan('scan-orphans')} disabled={isScanning} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />} Scan Disks
                        </Button>
                    </div>

                    {orphans && orphans.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-border bg-muted/30">
                            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
                            <p className="font-bold text-foreground">No orphaned files! Disk is perfectly clean.</p>
                        </div>
                    )}

                    {orphans && orphans.length > 0 && (
                        <Card className="border-primary/20 bg-background overflow-hidden">
                            <div className="flex flex-col sm:flex-row justify-between sm:items-center p-4 border-b border-border bg-muted/50 gap-4">
                                <span className="font-bold text-primary">Found {orphans.length} Wasted Files</span>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button size="sm" variant="outline" className="border-border hover:bg-muted text-foreground" onClick={() => {
                                        if (selectedOrphans.size === orphans.length) setSelectedOrphans(new Set());
                                        else setSelectedOrphans(new Set(orphans.map(o => o.path)));
                                    }}>
                                        {selectedOrphans.size === orphans.length ? "Deselect All" : "Select All"}
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={ignoreOrphans} disabled={selectedOrphans.size === 0 || isResolving} className="border-border hover:bg-muted text-foreground">
                                        {isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <EyeOff className="w-4 h-4 mr-2"/>} 
                                        Ignore ({selectedOrphans.size})
                                    </Button>
                                    <Button size="sm" variant="destructive" onClick={deleteOrphans} disabled={selectedOrphans.size === 0 || isResolving}>
                                        {isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Trash2 className="w-4 h-4 mr-2"/>} 
                                        Delete ({selectedOrphans.size})
                                    </Button>
                                </div>
                            </div>
                            <div className="divide-y border-border max-h-[500px] overflow-y-auto">
                                {orphans.map((o, i) => (
                                    <div key={i} className="p-3 text-sm flex items-start gap-3 hover:bg-muted transition-colors">
                                        <div className="pt-0.5">
                                            <Checkbox 
                                                checked={selectedOrphans.has(o.path)}
                                                onCheckedChange={(checked) => {
                                                    const next = new Set(selectedOrphans);
                                                    if (checked) next.add(o.path);
                                                    else next.delete(o.path);
                                                    setSelectedOrphans(next);
                                                }}
                                                className="border-border data-[state=checked]:bg-primary"
                                            />
                                        </div>
                                        <div className="flex flex-col min-w-0 cursor-pointer" onClick={() => {
                                            const next = new Set(selectedOrphans);
                                            if (next.has(o.path)) next.delete(o.path); else next.add(o.path);
                                            setSelectedOrphans(next);
                                        }}>
                                            <div className="font-bold truncate text-foreground">{o.name}</div>
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
                    <div className="flex justify-between items-center bg-primary/10 border border-primary/20 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-primary">Archive Integrity Checker</h3>
                            <p className="text-sm text-primary/80">Tests the internal headers of your files to find corrupted/incomplete downloads. <strong className="font-black">Warning: May take several minutes for massive libraries.</strong></p>
                        </div>
                        <Button onClick={() => runScan('scan-integrity')} disabled={isScanning} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldAlert className="w-4 h-4 mr-2" />} Test Archives
                        </Button>
                    </div>

                    {corrupted && corrupted.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-border bg-muted/30">
                            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
                            <p className="font-bold text-foreground">100% Integrity. No corrupted files detected!</p>
                        </div>
                    )}

                    {corrupted && corrupted.length > 0 && (
                        <Card className="border-primary/20 bg-background overflow-hidden">
                            <div className="p-4 border-b border-border bg-muted/50">
                                <span className="font-bold text-primary">Found {corrupted.length} Corrupted Archives</span>
                            </div>
                            <div className="divide-y border-border max-h-[500px] overflow-y-auto">
                                {corrupted.map((c, i) => (
                                    <div key={i} className="p-3 text-sm flex flex-col hover:bg-muted transition-colors">
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

            {/* CONTENT: DUPLICATES */}
            {activeTab === 'duplicates' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                    <div className="flex justify-between items-center bg-primary/10 border border-primary/20 p-4 rounded-xl">
                        <div>
                            <h3 className="font-bold text-primary">Duplicate Resolver</h3>
                            <p className="text-sm text-primary/80">Finds issues in the same series that share the exact same issue number (e.g. multiple versions of Issue #1). Pick the copy to <strong>keep</strong> in each group — the rest are deleted from disk. Groups whose filenames disagree about the issue number are flagged as likely metadata mispairs — those want a metadata refresh, not a deletion.</p>
                        </div>
                        <Button onClick={() => runScan('scan-duplicates')} disabled={isScanning} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold shrink-0">
                            {isScanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4 mr-2" />} Find Duplicates
                        </Button>
                    </div>

                    {duplicates && duplicates.length === 0 && (
                        <div className="text-center py-12 border-2 border-dashed rounded-xl border-border bg-muted/30">
                            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
                            <p className="font-bold text-foreground">No duplicate issues found in your library!</p>
                        </div>
                    )}

                    {duplicates && duplicates.length > 0 && (
                        <Card className="border-primary/20 bg-background overflow-hidden p-4 space-y-4">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-4">
                                <span className="font-bold text-primary">Found {duplicates.length} duplicate group{duplicates.length > 1 ? 's' : ''}</span>
                                <Button size="sm" variant="destructive" disabled={isResolving} onClick={() => {
                                    const ids = duplicates.flatMap((g, idx) => idsToDeleteFor(g, groupKey(g, idx)));
                                    if (ids.length === 0) { toast({ title: "Nothing to delete", description: "Every group is set to keep all copies." }); return; }
                                    setPendingDelete({ ids, label: `Delete ${ids.length} duplicate file${ids.length > 1 ? 's' : ''} across ${duplicates.length} group${duplicates.length > 1 ? 's' : ''}, keeping your selected copy in each?` });
                                }}>
                                    {isResolving ? <Loader2 className="w-4 h-4 animate-spin mr-2"/> : <Trash2 className="w-4 h-4 mr-2"/>} Resolve All (keep selected)
                                </Button>
                            </div>

                            {duplicates.map((group, idx) => {
                                const key = groupKey(group, idx);
                                const keepId = keepMap[key];
                                const deleteCount = idsToDeleteFor(group, key).length;
                                const mispair = !!group.suspectedMispair;
                                return (
                                    <div key={key} className={`bg-muted/30 border rounded-lg p-4 ${mispair ? 'border-amber-500/40' : 'border-border'}`}>
                                        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                            <h4 className="font-bold text-foreground">{group.seriesName} <Badge variant="secondary">{group.isAnnual ? 'Annual' : 'Issue'} #{group.issueNumber}</Badge>
                                                {mispair && <Badge variant="outline" className="ml-1 border-amber-500/60 text-amber-500"><AlertTriangle className="w-3 h-3 mr-1" /> Suspected mispair</Badge>}
                                            </h4>
                                            <div className="flex items-center gap-3">
                                                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                                                    <input
                                                        type="radio"
                                                        name={`keep-${key}`}
                                                        checked={keepId === KEEP_ALL}
                                                        onChange={() => setKeepMap(m => ({ ...m, [key]: KEEP_ALL }))}
                                                        className="accent-green-600"
                                                    />
                                                    Keep all copies
                                                </label>
                                                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                                                    <input
                                                        type="radio"
                                                        name={`keep-${key}`}
                                                        checked={keepId === DELETE_ALL}
                                                        onChange={() => setKeepMap(m => ({ ...m, [key]: DELETE_ALL }))}
                                                        className="accent-red-600"
                                                    />
                                                    Delete all copies
                                                </label>
                                            </div>
                                        </div>
                                        {mispair && (
                                            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 p-3 rounded border border-amber-500/40 bg-amber-500/10">
                                                <p className="text-xs text-amber-600 dark:text-amber-400 flex-1 min-w-[16rem]">
                                                    <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                                                    These files disagree about which issue they are ({group.files.map((f: any) => `#${f.parsedNumber}`).join(' vs ')}), so they are probably <strong>different comics</strong> mislabeled with the same number by an earlier metadata mix-up — not real duplicates. Deleting a copy would remove a real issue. Refresh Metadata re-pairs the records instead; nothing here is pre-selected for deletion.
                                                </p>
                                                {group.seriesMetadataId && (
                                                    <Button size="sm" variant="outline" className="border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 shrink-0"
                                                        disabled={refreshingKey === key}
                                                        onClick={() => queueMetadataRefresh(group, key)}>
                                                        {refreshingKey === key ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />} Refresh Metadata
                                                    </Button>
                                                )}
                                            </div>
                                        )}
                                        <div className="space-y-2">
                                            {group.files.map((file: any) => {
                                                const isKeep = keepId === file.id;
                                                const willDelete = keepId === DELETE_ALL || (keepId !== KEEP_ALL && !isKeep);
                                                return (
                                                    <label
                                                        key={file.id}
                                                        className={`flex items-center gap-3 p-3 rounded border cursor-pointer transition-colors ${isKeep ? 'border-green-500/60 bg-green-500/5' : willDelete ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-background'}`}
                                                    >
                                                        <input
                                                            type="radio"
                                                            name={`keep-${key}`}
                                                            checked={isKeep}
                                                            onChange={() => setKeepMap(m => ({ ...m, [key]: file.id }))}
                                                            className="accent-green-600 shrink-0"
                                                        />
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                                                            <p className="text-xs text-muted-foreground font-mono truncate" title={file.path}>{file.path}</p>
                                                            <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB{mispair && <span className="text-amber-600 dark:text-amber-400"> · filename says #{file.parsedNumber}</span>}</p>
                                                        </div>
                                                        {isKeep
                                                            ? <Badge className="shrink-0 bg-green-600 text-white hover:bg-green-600"><Star className="w-3 h-3 mr-1" /> Keep</Badge>
                                                            : willDelete
                                                                ? <Badge variant="outline" className="shrink-0 border-red-500/40 text-red-500"><Trash2 className="w-3 h-3 mr-1" /> Delete</Badge>
                                                                : null}
                                                    </label>
                                                );
                                            })}
                                        </div>
                                        <div className="flex justify-end mt-3">
                                            <Button size="sm" variant="destructive" disabled={isResolving || deleteCount === 0} onClick={() => {
                                                const ids = idsToDeleteFor(group, key);
                                                setPendingDelete({ ids, label: `Delete ${ids.length} copy/copies of ${group.seriesName} #${group.issueNumber}${keepId === DELETE_ALL ? ' (keeping none)' : ', keeping the selected copy'}?` });
                                            }}>
                                                <Trash2 className="w-4 h-4 mr-2" /> Delete {deleteCount} in this group
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </Card>
                    )}
                </div>
            )}

            <ConfirmationDialog
                isOpen={!!pendingDelete}
                onClose={() => setPendingDelete(null)}
                onConfirm={() => { if (pendingDelete) runDelete(pendingDelete.ids); }}
                title="Delete duplicate files?"
                description={`${pendingDelete?.label ?? ''} This permanently removes the file(s) from disk and cannot be undone.`}
                confirmText="Delete"
                variant="destructive"
                isLoading={isResolving}
            />
        </div>
    )
}