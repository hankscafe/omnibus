// src/app/admin/settings/tabs/metadata-tab.tsx
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
import { Database, Key, Loader2, CheckCircle } from "lucide-react"
import { StatusBox } from "./shared"
import type { SettingsBag } from "./shared"

export function MetadataTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, isSourceAvailable, handleTest, testing, testResults,
    cacheStats, clearMetadataCache, clearingCache
  } = s;

  return (
    <>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Database className="w-5 h-5 text-primary" /> Metadata Providers</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure the sources used to automatically pull covers, synopses, and creator credits for your library.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                    
                    <div className="space-y-4 pb-6 border-b border-border">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                                    <Database className="w-4 h-4 text-primary" /> Primary Metadata Source
                                </h3>
                                <p className="text-[0.8rem] text-muted-foreground mt-1 max-w-2xl">
                                    Select the default provider for all automated metadata fetching, Smart Match auto-scanning, interactive searches, and Discover page population. 
                                    <strong> You must configure the corresponding provider's credentials below before you can select it.</strong> 
                                    If you select Metron, the "Popular Issues" section on the Discover page will be disabled.
                                </p>
                            </div>
                            <Badge variant="outline" className="hidden sm:inline-flex text-[10px] uppercase font-bold border-orange-500 text-orange-600 bg-orange-50 dark:bg-orange-900/20">
                                Experimental
                            </Badge>
                        </div>
                        <Select 
                            value={config.primary_metadata_source || "COMICVINE"} 
                            onValueChange={(v) => {
                                if (v === "METRON") {
                                    setConfig({...config, primary_metadata_source: v, show_popular_issues: "false"});
                                } else {
                                    setConfig({...config, primary_metadata_source: v});
                                }
                            }}
                            disabled={!isSourceAvailable("COMICVINE") && !isSourceAvailable("METRON")}
                        >
                            <SelectTrigger className="w-full sm:w-[300px] h-12 sm:h-10 bg-muted/50 border-border text-foreground font-bold">
                                <SelectValue placeholder="Select a Provider" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="COMICVINE" disabled={!isSourceAvailable("COMICVINE")}>
                                    ComicVine (Default) {!isSourceAvailable("COMICVINE") && "(Needs API Key)"}
                                </SelectItem>
                                <SelectItem value="METRON" disabled={!isSourceAvailable("METRON")}>
                                    Metron.Cloud {!isSourceAvailable("METRON") && "(Needs Credentials)"}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        {(!isSourceAvailable("COMICVINE") && !isSourceAvailable("METRON")) && (
                            <p className="text-xs text-red-500 font-medium">Please configure at least one provider below to enable this selection.</p>
                        )}
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-2"><Key className="w-4 h-4 text-primary" /> ComicVine Integration</h3>
                        <div className="grid gap-2">
                            <Label className="text-foreground font-semibold">ComicVine API Key <span className="text-red-500">*</span></Label>
                            <Input type="password" value={config.cv_api_key || ""} onChange={(e) => setConfig({...config, cv_api_key: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                        </div>
                        <p className="text-[0.8rem] text-muted-foreground">Get your free API Key from <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noreferrer" className="underline text-primary hover:text-primary/80 transition-colors">ComicVine.com/api</a>.</p>
                        
                        <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('comicvine')} disabled={!!testing}>
                            {testing === 'comicvine' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test Connection
                        </Button>
                        <StatusBox result={testResults.comicvine} />
                    </div>

                    <div className="space-y-4 pt-4">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2 border-b border-border pb-2"><Database className="w-4 h-4 text-primary" /> Metron.Cloud Integration (Optional)</h3>
                        <p className="text-[0.8rem] text-muted-foreground">Metron is an open-source alternative to ComicVine.  Metron integration is required to populate the Release Calendar.</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label className="text-foreground font-semibold">Metron Username</Label>
                                <Input value={config.metron_user || ""} onChange={(e) => setConfig({...config, metron_user: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-foreground font-semibold">Metron Password</Label>
                                <Input type="password" value={config.metron_pass || ""} onChange={(e) => setConfig({...config, metron_pass: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                            </div>
                        </div>
                        
                        <div className="border-t border-border my-4" />
                        <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('metron')} disabled={!!testing}>
                            {testing === 'metron' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test Connection
                        </Button>
                        <StatusBox result={testResults.metron} />
                    </div>

                    <div className="space-y-4 pt-6 border-t border-border mt-4">
                        <div>
                            <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                                <Database className="w-4 h-4 text-primary" /> Series "Ended" Detection
                            </h3>
                            <p className="text-[0.8rem] text-muted-foreground mt-1">
                                ComicVine and Metron rarely record when a series actually ends, so Omnibus guesses: if no new issue has been
                                released within this window, the series is marked as Ended during metadata syncs. Choose a longer window for
                                slow-publishing series, or Never to only trust the providers.
                            </p>
                        </div>
                        <Select
                            value={config.series_ended_months || "18"}
                            onValueChange={(v) => setConfig({...config, series_ended_months: v})}
                        >
                            <SelectTrigger className="w-full sm:w-[300px] h-12 sm:h-10 bg-muted/50 border-border text-foreground font-bold">
                                <SelectValue placeholder="18 Months" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="6">6 Months</SelectItem>
                                <SelectItem value="12">12 Months</SelectItem>
                                <SelectItem value="18">18 Months (Default)</SelectItem>
                                <SelectItem value="24">24 Months</SelectItem>
                                <SelectItem value="36">36 Months</SelectItem>
                                <SelectItem value="0">Never (Trust Providers Only)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-4 pt-6 border-t border-border mt-4">
                        <div className="space-y-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Label className="text-base font-bold text-foreground">Match Confidence Mode</Label>
                            <Select value={config.matcher_mode || "confirm"} onValueChange={(v) => setConfig({...config, matcher_mode: v})}>
                                <SelectTrigger className="h-12 sm:h-10 w-full sm:w-[340px] bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-popover border-border">
                                    <SelectItem value="trust" className="focus:bg-primary/10 focus:text-primary">Trust — auto-accept file IDs & confident matches</SelectItem>
                                    <SelectItem value="confirm" className="focus:bg-primary/10 focus:text-primary">Confirm — file IDs auto, suggestions need approval</SelectItem>
                                    <SelectItem value="auto" className="focus:bg-primary/10 focus:text-primary">Auto — file IDs auto, only near-exact name matches</SelectItem>
                                    <SelectItem value="custom" className="focus:bg-primary/10 focus:text-primary">Custom — no automation, match by hand / custom ID</SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">
                                How much matching automation to allow. Embedded provider IDs (ComicInfo.xml / series.json) are deterministic and always applied except in Custom mode. The hourly background sweep retries unmatched series within the ComicVine rate budget, so big library imports finish matching themselves instead of stalling at the 200/hr wall.
                            </p>
                            {config.matcher_mode === "trust" && (
                                <div className="flex items-center gap-3 pt-1">
                                    <Input
                                        type="number" min="0.5" max="1" step="0.05"
                                        value={config.matcher_auto_threshold || "0.90"}
                                        onChange={e => setConfig({...config, matcher_auto_threshold: e.target.value})}
                                        className="h-10 w-28 bg-background border-border text-foreground"
                                    />
                                    <span className="text-[11px] text-muted-foreground">Similarity required to auto-accept a name-search match (0.5-1.0, default 0.90).</span>
                                </div>
                            )}
                        </div>

                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch
                                id="file-metadata-priority"
                                checked={config.file_metadata_priority === "true"}
                                onCheckedChange={(c) => setConfig({...config, file_metadata_priority: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="file-metadata-priority" className="cursor-pointer font-bold text-base text-foreground">
                                    Prefer Embedded File Metadata
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                    When on, metadata syncs only fill in blanks — titles, synopses, credits and genres that came from ComicInfo.xml / series.json are never overwritten by the provider. Manually locked series and issues are protected either way. Turn off to let provider refreshes replace file-derived data.
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch
                                id="metron-detail-credits"
                                checked={config.metron_detail_credits === "true"}
                                onCheckedChange={(c) => setConfig({...config, metron_detail_credits: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="metron-detail-credits" className="cursor-pointer font-bold text-base text-foreground">
                                    Metron: Fetch Per-Issue Credits
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                    Metron&apos;s issue list carries no creator credits, so syncs normally leave them to ComicInfo.xml or on-demand lookups. When on, metadata syncs make one extra Metron API call per issue to fill in writers, artists, characters and story arcs — quota-heavy on large libraries (budgeted against Metron&apos;s 5,000/day limit; leftovers resume on the next sync). Each issue is only fetched once.
                                </p>
                            </div>
                        </div>

                        <div className="space-y-3 bg-muted/30 p-4 rounded-lg border border-border">
                            <div className="flex items-center space-x-2">
                                <Switch
                                    id="metadata-cache"
                                    checked={config.metadata_cache_enabled === "true"}
                                    onCheckedChange={(c) => setConfig({...config, metadata_cache_enabled: c ? "true" : "false"})}
                                    className="scale-110 sm:scale-100"
                                />
                                <div className="grid gap-1 ml-2">
                                    <Label htmlFor="metadata-cache" className="cursor-pointer font-bold text-base text-foreground">
                                        Cache Provider Responses
                                    </Label>
                                    <p className="text-[11px] text-muted-foreground">
                                        Stores ComicVine and Metron API responses locally so repeat lookups cost zero rate limit — shared by the app and the engine. Trade-off: within the windows below, syncs can return slightly stale data and the Series Monitor may notice brand-new issues up to the search/list window later. An explicit &quot;Refresh Metadata&quot; always fetches live, and window changes apply to already-cached entries immediately.
                                    </p>
                                </div>
                            </div>
                            {config.metadata_cache_enabled === "true" && (
                                <div className="flex flex-wrap gap-4 pl-2">
                                    <div className="grid gap-1">
                                        <Label className="text-xs font-semibold text-foreground">Detail lookups (days)</Label>
                                        <Input type="number" min="1" max="90" value={config.metadata_cache_detail_days || "7"}
                                            onChange={e => setConfig({...config, metadata_cache_detail_days: e.target.value})}
                                            className="h-9 w-28 bg-background border-border text-foreground" />
                                    </div>
                                    <div className="grid gap-1">
                                        <Label className="text-xs font-semibold text-foreground">Searches &amp; lists (hours)</Label>
                                        <Input type="number" min="1" max="168" value={config.metadata_cache_list_hours || "12"}
                                            onChange={e => setConfig({...config, metadata_cache_list_hours: e.target.value})}
                                            className="h-9 w-28 bg-background border-border text-foreground" />
                                    </div>
                                    <div className="grid gap-1">
                                        <Label className="text-xs font-semibold text-foreground">Size cap (MB)</Label>
                                        <Input type="number" min="16" max="4096" value={config.metadata_cache_max_mb || "256"}
                                            onChange={e => setConfig({...config, metadata_cache_max_mb: e.target.value})}
                                            className="h-9 w-28 bg-background border-border text-foreground" />
                                    </div>
                                </div>
                            )}
                            <div className="flex items-center gap-3 pl-2 pt-1">
                                <p className="text-[11px] text-muted-foreground">
                                    {cacheStats ? `${cacheStats.entries} cached responses · ${(cacheStats.bytes / 1024 / 1024).toFixed(1)} MB` : 'Cache stats unavailable.'}
                                </p>
                                <Button
                                    variant="outline" size="sm"
                                    className="h-7 px-3 text-xs font-bold border-border"
                                    onClick={clearMetadataCache}
                                    disabled={clearingCache || !cacheStats || cacheStats.entries === 0}
                                >
                                    {clearingCache ? 'Clearing...' : 'Clear Cache'}
                                </Button>
                            </div>
                        </div>

                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch
                                id="export-series-json"
                                checked={config.export_series_json !== "false"}
                                onCheckedChange={(c) => setConfig({...config, export_series_json: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="export-series-json" className="cursor-pointer font-bold text-base text-foreground">
                                    Export series.json for Komga / Kavita
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                    Automatically writes a Mylar-format (v1.0.2) <code>series.json</code> file to the root of your series folders. External reading servers mapped to the same storage recognize your metadata instantly, and together with embedded ComicInfo.xml it makes your library fully self-describing — a rescan (even into a fresh database) rebuilds everything without new metadata-provider calls. Omnibus never overwrites a <code>series.json</code> it didn&apos;t create, so curated Mylar libraries are safe.
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch
                                id="metadata-write-comicinfo"
                                checked={config.metadata_write_comicinfo !== "false"}
                                onCheckedChange={(c) => setConfig({...config, metadata_write_comicinfo: c ? "true" : "false"})}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="metadata-write-comicinfo" className="cursor-pointer font-bold text-base text-foreground">
                                    Write metadata edits to ComicInfo.xml
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                    Default for the Edit Metadata dialog: when on, manual edits are embedded back into each comic's <code>ComicInfo.xml</code>. When off, edits are kept in Omnibus only and the files are left untouched (Komga-style). Each edit can still override this with its own toggle.
                                </p>
                            </div>
                        </div>

                        {/* Cover art source */}
                        <div className="bg-muted/30 p-4 rounded-lg border border-border space-y-3">
                            <div className="grid gap-1">
                                <Label className="font-bold text-base text-foreground">Cover Art Source</Label>
                                <p className="text-[11px] text-muted-foreground">
                                    Where series covers come from. The first page of a comic can be extracted into <code>cover.jpg</code> so even un-matched books get a real cover. An admin's uploaded cover always wins. Changing this won't re-cover series that already have one.
                                </p>
                            </div>
                            <Select
                                value={config.cover_source || "metadata"}
                                onValueChange={(v) => setConfig({...config, cover_source: v})}
                            >
                                <SelectTrigger className="w-full sm:w-[380px] h-12 sm:h-10 bg-muted/50 border-border text-foreground font-bold">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="metadata">Metadata provider, archive fills gaps (default)</SelectItem>
                                    <SelectItem value="archive">Comic archive first page, provider fills gaps</SelectItem>
                                    <SelectItem value="metadata_only">Metadata provider only (no archive extraction)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </CardContent>
            </Card>
    </>
  )
}
