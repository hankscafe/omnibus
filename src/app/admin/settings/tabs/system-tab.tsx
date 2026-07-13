// src/app/admin/settings/tabs/system-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Settings, Database, Save, Zap, FileText, Folder, Clock, FolderOpen, CheckCircle2, Loader2 } from "lucide-react"
import { StatusBox } from "./shared"
import type { SettingsBag } from "./shared"

export function SystemTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, envPaths, handleTest, testing, testResults
  } = s;

  return (
    <>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Settings className="w-5 h-5 text-primary" /> System & Engine</CardTitle>
                    <CardDescription className="text-muted-foreground">Engine performance tuning and the environment paths this instance runs with. Job schedules live on the Scheduled Jobs page.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                        {/* --- ENGINE CONCURRENCY / PERFORMANCE UI --- */}
                        <div className="grid gap-4">
                            <div>
                                <h3 className="text-lg font-bold text-foreground">Engine Performance (Concurrency)</h3>
                                <p className="text-[11px] text-muted-foreground mt-1">
                                    Tune how hard the Rust engine works the CPU, disk, and memory during scans, conversions, and metadata embedding. Leave a field blank (or 0) for <span className="font-semibold">Auto</span>, which derives a safe value from the host&apos;s CPU count. In a CPU-limited container, set the CPU cap explicitly — auto-detection sees the host&apos;s cores, not the container&apos;s quota. Worker-count changes apply to the next job; the CPU and blocking-pool caps apply after an engine restart.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="grid gap-1.5">
                                    <Label className="text-foreground font-semibold">Max scan workers</Label>
                                    <Input type="number" min="0" placeholder="Auto (CPU cores)" value={config.engine_max_scan_workers ?? ""} onChange={e => setConfig({...config, engine_max_scan_workers: e.target.value})} className="h-10 bg-muted/50 border-border text-foreground" />
                                    <p className="text-[10px] text-muted-foreground">Parallel file-probe / folder-walk tasks for library scans and diagnostics (ghost / storage / integrity).</p>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label className="text-foreground font-semibold">Max convert workers</Label>
                                    <Input type="number" min="0" placeholder="Auto (half cores)" value={config.engine_max_convert_workers ?? ""} onChange={e => setConfig({...config, engine_max_convert_workers: e.target.value})} className="h-10 bg-muted/50 border-border text-foreground" />
                                    <p className="text-[10px] text-muted-foreground">Simultaneous heavy archive jobs: CBR-to-CBZ conversion, repack, and metadata embedding.</p>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label className="text-foreground font-semibold">CPU cap (threads)</Label>
                                    <Input type="number" min="0" placeholder="Auto (all cores)" value={config.engine_cpu_cap ?? ""} onChange={e => setConfig({...config, engine_cpu_cap: e.target.value})} className="h-10 bg-muted/50 border-border text-foreground" />
                                    <p className="text-[10px] text-muted-foreground">Total worker threads for the engine (tokio + image-encoding pool). Restart required.</p>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label className="text-foreground font-semibold">Max blocking threads</Label>
                                    <Input type="number" min="0" placeholder="Auto (64)" value={config.engine_max_blocking_threads ?? ""} onChange={e => setConfig({...config, engine_max_blocking_threads: e.target.value})} className="h-10 bg-muted/50 border-border text-foreground" />
                                    <p className="text-[10px] text-muted-foreground">Ceiling on concurrent blocking file operations (backstop). Restart required.</p>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label className="text-foreground font-semibold">Memory ceiling (MB)</Label>
                                    <Input type="number" min="0" placeholder="0 = disabled" value={config.engine_memory_ceiling_mb ?? ""} onChange={e => setConfig({...config, engine_memory_ceiling_mb: e.target.value})} className="h-10 bg-muted/50 border-border text-foreground" />
                                    <p className="text-[10px] text-muted-foreground">Soft cap: when set, derates the scan / convert worker counts to fit (~64&nbsp;MB per task).</p>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label className="text-foreground font-semibold">Max DB connections</Label>
                                    <Input type="number" min="0" placeholder="Auto (from workers)" value={config.engine_max_db_connections ?? ""} onChange={e => setConfig({...config, engine_max_db_connections: e.target.value})} className="h-10 bg-muted/50 border-border text-foreground" />
                                    <p className="text-[10px] text-muted-foreground">Engine&apos;s PostgreSQL pool size. Auto-derives from the worker counts so parallel jobs don&apos;t starve on connections. Restart required.</p>
                                </div>
                            </div>
                        </div>
                        {/* --- DOCKER VOLUME BINDINGS UI --- */}
                        <div className="grid gap-2 pt-6 border-t border-border mt-4">
                            <Label className="text-foreground font-semibold text-lg flex items-center gap-2"><Database className="w-4 h-4 text-primary"/> Environment Paths (System Defaults)</Label>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><Database className="w-3 h-3"/> Database Path</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.DATABASE_URL}>{envPaths?.DATABASE_URL?.replace('file:', '') || '/config/omnibus.db'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Where the SQLite database file is stored.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><Save className="w-3 h-3"/> Backup Directory</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_BACKUPS_DIR}>{envPaths?.OMNIBUS_BACKUPS_DIR || '/config/backups'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Where automated database backups are saved.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><Zap className="w-3 h-3"/> Cache & Temp Dir</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_CACHE_DIR}>{envPaths?.OMNIBUS_CACHE_DIR || '/config/cache'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Map this to a drive with plenty of free space.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><FileText className="w-3 h-3"/> Log Directory</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_LOGS_DIR}>{envPaths?.OMNIBUS_LOGS_DIR || '/config/logs'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Where system activity logs are written.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><Folder className="w-3 h-3"/> Watched Directory</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_WATCHED_DIR}>{envPaths?.OMNIBUS_WATCHED_DIR || '/watched'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Where watched media files are stored.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><Clock className="w-3 h-3"/> Awaiting Match Directory</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_AWAITING_MATCH_DIR}>{envPaths?.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Where files awaiting match are stored.</p>
                                </div>
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-2">
                                These paths are configured via Environment Variables (<code className="text-foreground font-bold">DATABASE_URL</code>, <code className="text-foreground font-bold">OMNIBUS_BACKUPS_DIR</code>, <code className="text-foreground font-bold">OMNIBUS_CACHE_DIR</code>, <code className="text-foreground font-bold">OMNIBUS_LOGS_DIR</code>) in your Docker setup. 
                            </p>
                        </div>
                </CardContent>
            </Card>
            <Card className="shadow-sm border-primary/20 bg-primary/5">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-primary">
                        <FolderOpen className="w-5 h-5" /> Docker Path Mappings (Test Area)
                    </CardTitle>
                    <CardDescription className="text-primary/70">Test your translation logic here. If qBittorrent sends a path, does it resolve correctly?</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="grid gap-2">
                            <Label className="text-xs font-bold uppercase text-primary/80">Test Remote Path</Label>
                            <Input 
                                value={config.remote_path_mapping || ""} 
                                onChange={e => setConfig({...config, remote_path_mapping: e.target.value})} 
                                placeholder="/downloads" 
                                className="h-12 sm:h-10 font-mono bg-background border-primary/30 text-foreground"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label className="text-xs font-bold uppercase text-primary/80">Test Local Path</Label>
                            <Input 
                                value={config.local_path_mapping || ""} 
                                onChange={e => setConfig({...config, local_path_mapping: e.target.value})} 
                                placeholder="/data/downloads" 
                                className="h-12 sm:h-10 font-mono bg-background border-primary/30 text-foreground"
                            />
                        </div>
                    </div>
                    <div className="border-t border-primary/20 my-2" />
                    <Button 
                        variant="outline" 
                        className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" 
                        onClick={() => handleTest('mapping', { remote: config.remote_path_mapping, local: config.local_path_mapping })} 
                        disabled={!!testing || !config.remote_path_mapping || !config.local_path_mapping}
                    >
                        {testing === 'mapping' ? (
                            <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/>
                        ) : testResults['mapping']?.success ? (
                            <CheckCircle2 className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-green-500"/>
                        ) : (
                            <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>
                        )} 
                        {testResults['mapping']?.success ? "Logic Verified!" : "Test Logic"}
                    </Button>
                    <StatusBox result={testResults.mapping} />
                </CardContent>
            </Card>
    </>
  )
}
