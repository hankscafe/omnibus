// src/app/admin/settings/tabs/downloads-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Download, Server, Search, ArrowUp, ArrowDown, CheckCircle2, CheckCircle, Plus, Trash2, Loader2, Zap, FolderOpen, Settings, Shield } from "lucide-react"
import { StatusBox, hosterDisplayNames, sourceDisplayNames } from "./shared"
import type { SettingsBag } from "./shared"

export function DownloadsTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, configuredClients, openClientSetup, deleteClient, setEditingClient,
    setClientModalOpen, setTestResults, testing, testResults, handleTest,
    searchSourcePriority, moveSearchSource, toggleSearchSourceEnabled,
    hosterPriority, moveHosterPriority, toggleHosterEnabled,
    configuredHosters, setAnnasKey, openHosterSetup, deleteHoster
  } = s;

  return (
    <>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Download className="w-5 h-5 text-primary" /> Download Clients</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure your clients. For Docker setups, use the "Settings" button on each client to configure specific Remote Path Mappings.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-10">
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Add Download Client(s)</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {[
                                { id: 'qbit', name: 'qBittorrent', protocol: 'Torrent' },
                                { id: 'sab', name: 'SABnzbd', protocol: 'Usenet' },
                                { id: 'deluge', name: 'Deluge', protocol: 'Torrent' },
                                { id: 'nzbget', name: 'NZBGet', protocol: 'Usenet' }
                            ].map((client) => {
                                const isAdded = configuredClients.some(c => c.type === client.id);
                                return (
                                    <div key={client.id} className={`p-4 sm:p-5 border border-border rounded-xl flex flex-col items-center justify-center space-y-3 transition-all ${isAdded ? 'bg-muted opacity-80 cursor-default shadow-none' : 'bg-muted/30 cursor-pointer hover:border-primary hover:shadow-md'}`} onClick={() => !isAdded && openClientSetup(client.id as any)}>
                                        <span className="font-bold text-lg sm:text-base text-foreground">{client.name}</span>
                                        <Badge variant="secondary" className={client.protocol === 'Torrent' ? "bg-primary/10 text-primary hover:bg-primary/20" : "bg-green-100 text-green-700 hover:bg-green-200"}>{client.protocol}</Badge>
                                        {isAdded ? (
                                            <Badge className="bg-green-600 text-white border-0 py-1.5 w-full flex justify-center"><CheckCircle2 className="w-4 h-4 sm:w-3 sm:h-3 mr-1.5"/> Configured</Badge>
                                        ) : (
                                            <Button variant="outline" size="sm" className="w-full h-10 sm:h-8 font-bold border-border bg-background hover:bg-muted text-foreground"><Plus className="w-4 h-4 sm:w-3 sm:h-3 mr-1.5"/> Add</Button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Configure Client(s)</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {configuredClients.length === 0 ? (
                                <div className="col-span-1 sm:col-span-2 text-center py-10 border-2 border-dashed border-border rounded-xl text-muted-foreground">No clients configured yet.</div>
                            ) : (
                                configuredClients.map((client) => (
                                    <Card key={client.id} className="shadow-sm border-border bg-background">
                                        <CardContent className="p-4 space-y-3">
                                            <div className="flex justify-between items-start">
                                                <div className="space-y-1 min-w-0 pr-2">
                                                    <p className="font-bold text-lg sm:text-base truncate text-foreground">{client.name}</p>
                                                    <Badge variant="secondary" className={client.protocol === 'Torrent' ? "bg-primary/10 text-primary" : "bg-green-100 text-green-700"}>{client.protocol}</Badge>
                                                    <p className="text-xs text-muted-foreground truncate pt-1">{client.url}</p>
                                                    {client.remotePath && (
                                                        <div className="flex items-center gap-1 text-[10px] text-primary bg-primary/10 px-2 py-1 rounded w-fit mt-1">
                                                            <FolderOpen className="w-3 h-3" />
                                                            Mapped: {client.remotePath} → {client.localPath}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:bg-muted text-foreground" onClick={() => {setTestResults(prev => ({ ...prev, clients: null }));setEditingClient(client); setClientModalOpen(true);}}><Settings className="h-5 w-5 sm:h-4 sm:w-4"/></Button>
                                                    <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => deleteClient(client.id)}><Trash2 className="h-5 h-5 sm:h-4 sm:w-4"/></Button>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Server className="w-5 h-5 text-primary" /> Direct Downloads & File Hosters</CardTitle>
                    <CardDescription className="text-muted-foreground">Manage priority and add premium credentials for third-party file hosters (like MediaFire or Mega).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-10">

                    {/* Automation Search Source Priority — which source automation tries first. Distinct
                        from the Hoster Priority list below, which only picks a file host for a GetComics hit. */}
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground flex items-center gap-2"><Search className="w-5 h-5 text-primary" /> Automation Search Source Priority</h3>
                        <p className="text-xs text-muted-foreground">For background (automated) downloads, Omnibus tries these sources in order and takes the first match. Reorder or disable them here. This is separate from the <strong>Hoster Priority</strong> list further down, which only chooses which file host to use for a GetComics result.</p>

                        <div className="border border-border rounded-lg bg-muted/20 p-2 space-y-1">
                            {searchSourcePriority.map((item, idx) => (
                                <div key={item.source} className={`flex items-center justify-between p-3 bg-background border border-border rounded shadow-sm transition-opacity ${!item.enabled ? 'opacity-50' : ''}`}>
                                    <div className="flex items-center gap-3">
                                        <Badge variant="secondary" className="font-mono text-[10px] w-6 justify-center bg-muted">{idx + 1}</Badge>
                                        <span className={`font-bold ${!item.enabled ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                                            {sourceDisplayNames[item.source] || item.source}
                                        </span>
                                        {item.source === 'annas_archive' && (
                                            <>
                                                <Badge variant="outline" className="text-[10px] uppercase font-bold border-orange-500 text-orange-600 bg-orange-50 dark:bg-orange-900/20">Experimental</Badge>
                                                <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300 dark:border-amber-700">needs API key</Badge>
                                            </>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-2 mr-2 sm:border-r sm:border-border sm:pr-3">
                                            <Switch
                                                checked={item.enabled}
                                                onCheckedChange={() => toggleSearchSourceEnabled(idx)}
                                                className="scale-90 sm:scale-100"
                                            />
                                            <Label className="text-xs font-bold cursor-pointer hidden sm:block" onClick={() => toggleSearchSourceEnabled(idx)}>
                                                {item.enabled ? "Enabled" : "Disabled"}
                                            </Label>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted" disabled={idx === 0} onClick={() => moveSearchSource(idx, -1)}>
                                                <ArrowUp className="w-4 h-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted" disabled={idx === searchSourcePriority.length - 1} onClick={() => moveSearchSource(idx, 1)}>
                                                <ArrowDown className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground">Enabling <strong>Anna's Archive</strong> for automation requires a premium API key and a passing connection test — otherwise it reverts to disabled on save. Interactive search still works without a key (toggle below).</p>
                    </div>

                    
                    <div className="flex items-center space-x-4 bg-muted/30 p-4 rounded-lg border border-border">
                        <Switch 
                            id="ddl-toggle"
                            checked={config.ddl_enabled !== "false"} 
                            onCheckedChange={(c) => setConfig({...config, ddl_enabled: c ? "true" : "false"})} 
                            className="scale-110 sm:scale-100"
                        />
                        <div className="grid gap-1">
                            <Label htmlFor="ddl-toggle" className="cursor-pointer font-bold text-base text-foreground">Enable Direct Downloads</Label>
                            <p className="text-[11px] text-muted-foreground">When enabled, Omnibus will search GetComics for direct download links before falling back to your Torrent/Usenet clients. Disable this if you only want to use Prowlarr.</p>
                        </div>
                    </div>

                    {/* --- MOVED: Advanced Download Rules --- */}
                    <div className="space-y-4 mt-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Advanced Download Rules</h3>
                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border mt-4">
                            <Switch 
                                id="bulk-pack-toggle"
                                checked={config.allow_bulk_packs === "true"} 
                                onCheckedChange={(c) => setConfig({...config, allow_bulk_packs: c ? "true" : "false"})} 
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="bulk-pack-toggle" className="cursor-pointer font-bold text-base text-foreground">Allow Bulk Collections & Packs</Label>
                                <p className="text-[11px] text-muted-foreground">If enabled, when requesting a single issue, Omnibus is allowed to download full "Story Arc" or "Chronological" zip packs from direct download sites if an exact single-issue file cannot be found.</p>
                            </div>
                        </div>

                        {/* --- NEW: Prioritize Packs Toggle --- */}
                        <div className={`flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border mt-2 transition-opacity ${config.allow_bulk_packs !== "true" ? "opacity-50 pointer-events-none" : ""}`}>
                            <Switch 
                                id="prioritize-packs-toggle"
                                checked={config.prioritize_packs === "true"} 
                                onCheckedChange={(c) => setConfig({...config, prioritize_packs: c ? "true" : "false"})} 
                                className="scale-110 sm:scale-100"
                                disabled={config.allow_bulk_packs !== "true"}
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="prioritize-packs-toggle" className="cursor-pointer font-bold text-base text-foreground">Prioritize Packs / Collections First</Label>
                                <p className="text-[11px] text-muted-foreground">If enabled, Omnibus will search for full series packs or collections <strong>before</strong> searching for individual issues. Highly recommended for faster library building.</p>
                            </div>
                        </div>

                        {/* Issue #176 change B: opt-in acceptance of undated indexer releases */}
                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border mt-2">
                            <Switch
                                id="accept-yearless-toggle"
                                checked={config.prowlarr_accept_yearless === "true"}
                                onCheckedChange={(c) => setConfig({...config, prowlarr_accept_yearless: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="accept-yearless-toggle" className="cursor-pointer font-bold text-base text-foreground">Accept Undated Indexer Releases</Label>
                                <p className="text-[11px] text-muted-foreground">Many Usenet/scene releases omit the year (e.g. <code>Batman 89 Echoes 003 (Digital)</code>), and by default Omnibus rejects them because the year is the only way to tell rebooted series apart (a "Wolverine 003" exists for the 1988, 2010, 2014 and 2020 volumes). Enable to accept undated releases — a release <strong>with</strong> a matching year is always preferred, so undated ones only download when nothing dated exists. Slight risk of grabbing the wrong volume of a rebooted series.</p>
                            </div>
                        </div>

                        {/* GetComics Interactive Search Depth */}
                        <div className="space-y-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Label htmlFor="getcomics_interactive_pages" className="font-bold text-foreground">Interactive Search Depth (Pages)</Label>
                            <Input 
                                id="getcomics_interactive_pages" 
                                type="number" 
                                min="1" 
                                max="15" 
                                value={config.getcomics_interactive_pages || "4"} 
                                onChange={(e) => setConfig({ ...config, getcomics_interactive_pages: e.target.value })} 
                                className="h-12 sm:h-10 bg-background border-border text-foreground w-full sm:w-32"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">
                                The maximum number of pages GetComics will scan during manual UI searches. Higher numbers pull more results but take longer to load. (Default: 4)
                            </p>
                        </div>

                        {/* GetComics Automated Search Depth */}
                        <div className="space-y-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Label htmlFor="getcomics_automated_pages" className="font-bold text-foreground">Automated Search Depth (Pages)</Label>
                            <Input 
                                id="getcomics_automated_pages" 
                                type="number" 
                                min="1" 
                                max="15" 
                                value={config.getcomics_automated_pages || "5"} 
                                onChange={(e) => setConfig({ ...config, getcomics_automated_pages: e.target.value })} 
                                className="h-12 sm:h-10 bg-background border-border text-foreground w-full sm:w-32"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">
                                The maximum number of pages GetComics will scan during background download queue tasks. (Default: 5)
                            </p>
                        </div>
                    </div>

                    {/* --- Anna's Archive (its own search source, independent of GetComics/Indexers) --- */}
                    <div className="space-y-4 mt-4 pt-6 border-t border-border">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2"><Server className="w-5 h-5 text-primary" /> Anna's Archive (Search Source) <Badge variant="outline" className="text-[10px] uppercase font-bold border-orange-500 text-orange-600 bg-orange-50 dark:bg-orange-900/20">Experimental</Badge></h3>
                        <p className="text-xs text-muted-foreground">Anna's Archive is its own search source, separate from GetComics and your Indexers. Interactive search works <strong>without</strong> an API key — gated files are sent to the manual download queue. For automatic downloads, add a premium API key under "Hoster Accounts" below.</p>

                        <div className="flex items-center space-x-4 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch
                                id="annas-interactive-toggle"
                                checked={config.annas_archive_interactive_enabled === "true"}
                                onCheckedChange={(c) => setConfig({...config, annas_archive_interactive_enabled: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1">
                                <Label htmlFor="annas-interactive-toggle" className="cursor-pointer font-bold text-base text-foreground">Include in Interactive Search</Label>
                                <p className="text-[11px] text-muted-foreground">When enabled, Interactive Search also queries Anna's Archive and shows its results alongside GetComics and your indexers. (No API key required.)</p>
                            </div>
                        </div>

                        <div className="space-y-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Label htmlFor="annas_archive_base_url" className="font-bold text-foreground">Anna's Archive Base URL</Label>
                            <Input
                                id="annas_archive_base_url"
                                value={config.annas_archive_base_url || ""}
                                placeholder="https://annas-archive.gl"
                                onChange={(e) => setConfig({ ...config, annas_archive_base_url: e.target.value })}
                                className="h-12 sm:h-10 bg-background border-border text-foreground"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">Anna's Archive rotates mirror domains frequently under takedown pressure (the old .org / .se / .li are gone; .gl is current as of mid-2026). If searches fail with a DNS / "no such host" error, set the current working mirror here — see the Anna's Archive Wikipedia page for the live list. Leave blank to use the default (annas-archive.gl).</p>
                        </div>

                        <div className="space-y-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Label htmlFor="annas_archive_api_key" className="font-bold text-foreground">Premium API Key <span className="text-muted-foreground font-normal">(optional)</span></Label>
                            <Input
                                id="annas_archive_api_key"
                                type="password"
                                value={configuredHosters.find(h => h.hoster === 'annas_archive')?.apiKey || ""}
                                placeholder="Required for automated downloads"
                                onChange={(e) => setAnnasKey(e.target.value)}
                                className="h-12 sm:h-10 bg-background border-border text-foreground"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">A membership <a href="https://annas-archive.gl/donate" target="_blank" rel="noreferrer" className="underline text-primary hover:text-primary/80">donation</a> grants a fast-download API key. Without one, Anna's Archive works for interactive search only. Use "Test API Key" below to verify it.</p>
                        </div>

                        <div className="space-y-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Label htmlFor="annas_archive_formats" className="font-bold text-foreground">Comic File Formats</Label>
                            <Input
                                id="annas_archive_formats"
                                value={config.annas_archive_formats || ""}
                                placeholder="cbz,cbr,pdf,epub"
                                onChange={(e) => setConfig({ ...config, annas_archive_formats: e.target.value })}
                                className="h-12 sm:h-10 bg-background border-border text-foreground"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">Comma-separated file extensions to include in Anna's Archive searches. Leave blank for the default (cbz, cbr, pdf, epub).</p>
                        </div>

                        {!configuredHosters.find(c => c.hoster === 'annas_archive')?.apiKey && (
                            <div className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                                No Anna's Archive API key is configured. Anna's Archive will work for <strong>interactive search only</strong> — gated files are sent to the manual download queue. Automation requires a premium API key (enter it above).
                            </div>
                        )}

                        <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('annas_archive')} disabled={!!testing}>
                            {testing === 'annas_archive' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test API Key
                        </Button>
                        <StatusBox result={testResults.annas_archive} />
                    </div>

                    <div className={`space-y-8 transition-opacity duration-300 pt-6 border-t border-border ${config.ddl_enabled === "false" ? "opacity-50 pointer-events-none" : ""}`}>
                    
                    {/* Priority List */}
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Hoster Priority</h3>
                        <p className="text-xs text-muted-foreground">If multiple hosters are available for a comic, Omnibus will prioritize them in this order. You can also disable hosters you do not want to use.</p>

                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch
                                id="gc-avoid-large"
                                checked={config.gc_avoid_large_downloads !== "false"}
                                onCheckedChange={(c) => setConfig({...config, gc_avoid_large_downloads: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="gc-avoid-large" className="cursor-pointer font-bold text-base text-foreground">
                                    Prefer Mirrors for Large Downloads (&gt;400MB)
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                    GetComics&apos; own servers throttle big files. When a result advertises more than 400MB, its GetComics-hosted links drop below the third-party mirrors in the order above — they stay available as the last-resort fallback, never excluded.
                                </p>
                            </div>
                        </div>

                        <div className="border border-border rounded-lg bg-muted/20 p-2 space-y-1">
                            {hosterPriority.map((item, idx) => (
                                <div key={item.hoster} className={`flex items-center justify-between p-3 bg-background border border-border rounded shadow-sm transition-opacity ${!item.enabled ? 'opacity-50' : ''}`}>
                                    <div className="flex items-center gap-3">
                                        <Badge variant="secondary" className="font-mono text-[10px] w-6 justify-center bg-muted">{idx + 1}</Badge>
                                        <span className={`font-bold ${!item.enabled ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                                            {hosterDisplayNames[item.hoster] || item.hoster}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-2 mr-2 sm:border-r sm:border-border sm:pr-3">
                                            <Switch 
                                                checked={item.enabled} 
                                                onCheckedChange={() => toggleHosterEnabled(idx)} 
                                                className="scale-90 sm:scale-100"
                                            />
                                            <Label className="text-xs font-bold cursor-pointer hidden sm:block" onClick={() => toggleHosterEnabled(idx)}>
                                                {item.enabled ? "Enabled" : "Disabled"}
                                            </Label>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted" disabled={idx === 0} onClick={() => moveHosterPriority(idx, -1)}>
                                                <ArrowUp className="w-4 h-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-muted" disabled={idx === hosterPriority.length - 1} onClick={() => moveHosterPriority(idx, 1)}>
                                                <ArrowDown className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Hoster Accounts */}
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Hoster Accounts (Optional)</h3>
                        <p className="text-xs text-muted-foreground mb-4">Add your free or premium credentials to bypass bandwidth limits.</p>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                            {['mediafire', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox'].map(type => {
                                const isAdded = configuredHosters.some(c => c.hoster === type);
                                return (
                                    <Button key={type} variant="outline" className={`h-12 font-bold ${isAdded ? 'border-primary text-primary bg-primary/5' : ''}`} onClick={() => !isAdded && openHosterSetup(type)}>
                                        {isAdded && <CheckCircle2 className="w-4 h-4 mr-2" />}
                                        {hosterDisplayNames[type] || type}
                                    </Button>
                                )
                            })}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {configuredHosters.filter(h => h.hoster !== 'annas_archive').length === 0 ? (
                                <div className="col-span-1 sm:col-span-2 text-center py-10 border-2 border-dashed border-border rounded-xl text-muted-foreground">No hoster accounts configured.</div>
                            ) : (
                                configuredHosters.filter(h => h.hoster !== 'annas_archive').map((hoster) => (
                                    <Card key={hoster.id} className="shadow-sm border-border bg-background">
                                        <CardContent className="p-4 space-y-3">
                                            <div className="flex justify-between items-start">
                                                <div className="space-y-1 min-w-0 pr-2">
                                                    <p className="font-bold text-sm truncate text-foreground">{hoster.name}</p>
                                                    <Badge variant="secondary" className="bg-primary/10 text-primary text-[10px]">{hoster.username || "API Key Linked"}</Badge>
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" onClick={() => deleteHoster(hoster.id)}><Trash2 className="h-4 w-4"/></Button>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))
                            )}
                        </div>
                    </div>
                    
                    </div>
                </CardContent>
            </Card>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Shield className="w-5 h-5 text-primary" /> Download Network & Request Lifecycle</CardTitle>
                    <CardDescription className="text-muted-foreground">Cloudflare bypass for direct downloads, retry cadence, and how stalled requests are reported.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* --- CLOUDFLARE SOLVER UI (FlareSolverr / Byparr) --- */}
                    <div className="space-y-4 pb-6 border-b border-border">
                        <Label className="text-base font-bold text-foreground">Cloudflare Bypass (FlareSolverr / Byparr)</Label>
                        <p className="text-[11px] text-muted-foreground mt-1">When GetComics serves a Cloudflare "Just a moment…" challenge on a download (or a 403 on a search), Omnibus routes the request through a solver to obtain clearance. FlareSolverr is the classic option; <strong>Byparr</strong> is a drop-in alternative (Camoufox-based) that clears the newer interactive Turnstile challenges FlareSolverr frequently times out on.</p>

                        <div className="space-y-2">
                            <Label htmlFor="solver_type" className="font-bold text-foreground">Solver Backend</Label>
                            <Select value={config.solver_type || "flaresolverr"} onValueChange={(v) => setConfig({ ...config, solver_type: v })}>
                                <SelectTrigger id="solver_type" className="h-12 sm:h-10 bg-background border-border text-foreground w-full sm:w-64">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="flaresolverr">FlareSolverr</SelectItem>
                                    <SelectItem value="byparr">Byparr</SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground mt-1">
                                Both speak the same API on port 8191, so the URL below works for either — point it at whichever container you run (Byparr: <code>ghcr.io/thephaseless/byparr</code>). The solve timeout is sent in the correct unit automatically (FlareSolverr uses milliseconds, Byparr uses seconds).
                            </p>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2">
                            <Input
                                placeholder="http://192.168.1.100:8191"
                                value={config.flaresolverr_url || ""}
                                onChange={e => setConfig({...config, flaresolverr_url: e.target.value})}
                                className="h-12 sm:h-10 bg-background border-border text-foreground flex-1 font-mono text-sm"
                            />
                            <Button variant="outline" onClick={() => handleTest('flaresolverr', { flaresolverr_url: config.flaresolverr_url, solver_type: config.solver_type })} disabled={!!testing} className="h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground">
                                {testing === 'flaresolverr' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin text-primary"/> : <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test Solver
                            </Button>
                        </div>
                        <StatusBox result={testResults.flaresolverr} />
                        <div className="space-y-2 pt-2">
                            <Label htmlFor="flaresolverr_timeout" className="font-bold text-foreground">Solve Timeout (Seconds)</Label>
                            <Input
                                id="flaresolverr_timeout"
                                type="number"
                                min="30"
                                max="600"
                                value={config.flaresolverr_timeout || "300"}
                                onChange={(e) => setConfig({ ...config, flaresolverr_timeout: e.target.value })}
                                className="h-12 sm:h-10 bg-background border-border text-foreground w-full sm:w-32"
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">
                                How long the solver is given to clear a Cloudflare challenge. The newer GetComics challenge can need up to 300s; raise this if downloads still time out. (Default: 300, range 30-600)
                            </p>
                        </div>
                    </div>

                    <div className="grid gap-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Label className="text-base font-bold text-foreground">Automated Download Retry Delay (Minutes)</Label>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                            <Input 
                                type="number" 
                                min="1" 
                                value={config.download_retry_delay || "5"} 
                                onChange={e => setConfig({...config, download_retry_delay: e.target.value})} 
                                className="h-12 sm:h-10 w-full sm:w-32 bg-background border-border text-foreground"
                            />
                            <span className="text-sm text-muted-foreground">
                                Wait time before automatically retrying a stalled/failed download (Max 3 retries).
                            </span>
                        </div>
                    </div>

                    <div className="grid gap-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Label className="text-base font-bold text-foreground">Awaiting-Release Retry (Days)</Label>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                            <Input
                                type="number"
                                min="1"
                                value={config.awaiting_retry_days || "7"}
                                onChange={e => setConfig({...config, awaiting_retry_days: e.target.value})}
                                className="h-12 sm:h-10 w-full sm:w-32 bg-background border-border text-foreground"
                            />
                            <span className="text-sm text-muted-foreground">
                                How often to re-search requests that aren't available on any source yet (brand-new / small-press titles). These retry on this slow cadence instead of counting as failures. (Default: 7)
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Switch
                            id="flag-stalled-requests"
                            checked={config.flag_stalled_requests !== "false"}
                            onCheckedChange={(c) => setConfig({...config, flag_stalled_requests: c ? "true" : "false"})}
                            className="scale-110 sm:scale-100"
                        />
                        <div className="grid gap-1 ml-2">
                            <Label htmlFor="flag-stalled-requests" className="cursor-pointer font-bold text-base text-foreground">
                                Flag stalled requests in System Health
                            </Label>
                            <p className="text-[11px] text-muted-foreground">
                                When on, downloads stuck after repeated retries count against System Health. Turn off if you track many niche/indie titles and don't want stalled requests to show the instance as Degraded. (Items still awaiting availability never count either way.)
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>
    </>
  )
}
