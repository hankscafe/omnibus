// src/app/admin/settings/tabs/discovery-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Filter, Database } from "lucide-react"
import { DEFAULT_MANGA_PUBLISHERS, DEFAULT_WESTERN_PUBLISHERS } from "@/lib/utils/default-publishers"

import type { SettingsBag } from "./shared"

export function DiscoveryTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, applyRecommendedFilters, applyForeignFilters
  } = s;

  return (
    <>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Filter className="w-5 h-5 text-primary" /> Discover & Filtering</CardTitle>
                    <CardDescription className="text-muted-foreground">Filter out unwanted series or publishers from the Discover grids (New Releases, Popular).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* Discover Page Sections */}
                    <div className="flex flex-col space-y-4 bg-muted/30 p-4 rounded-lg border border-border">
                        <Label className="text-base font-bold text-foreground">Discover Page Sections</Label>
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center space-x-2">
                                <Switch 
                                    id="popular-toggle"
                                    checked={config.show_popular_issues === "true" && config.primary_metadata_source !== "METRON"} 
                                    onCheckedChange={(c) => setConfig({...config, show_popular_issues: c ? "true" : "false"})} 
                                    disabled={config.primary_metadata_source === "METRON"}
                                />
                                <div className="grid gap-0.5">
                                    <Label htmlFor="popular-toggle" className={`cursor-pointer font-bold text-sm ${config.primary_metadata_source === "METRON" ? 'text-muted-foreground' : 'text-foreground'}`}>
                                        Show Popular Issues
                                    </Label>    
                                    {config.primary_metadata_source === "METRON" && (
                                        <p className="text-[10px] text-muted-foreground">Unavailable when Metron is the primary source.</p>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center space-x-2">
                                <Switch 
                                    id="new-toggle"
                                    checked={config.show_new_releases !== "false"} 
                                    onCheckedChange={(c) => setConfig({...config, show_new_releases: c ? "true" : "false"})} 
                                />
                                <Label htmlFor="new-toggle" className="cursor-pointer font-bold text-sm text-foreground">Show New Releases</Label>
                            </div>
                        </div>
                    </div>

                    {/* MANGA DISCOVERY FILTERS */}
                    <div className="space-y-4 pt-6 border-t border-border mt-6">
                        <Label className="text-base font-bold text-foreground">Manga Discovery Filters</Label>
                        <div className="grid gap-4 bg-muted/30 p-4 rounded-lg border border-border">
                            <div className="space-y-2">
                                <Label className="text-foreground font-semibold">Manga Visibility</Label>
                                <Select 
                                    value={config.discover_manga_filter_mode || "SHOW_ALL"} 
                                    onValueChange={v => setConfig({...config, discover_manga_filter_mode: v})}
                                >
                                    <SelectTrigger className="bg-background border-border h-12 sm:h-10 text-foreground">
                                        <SelectValue />
                                    </SelectTrigger>
                                        <SelectContent className="bg-popover border-border">
                                        <SelectItem value="SHOW_ALL">Show All Manga (Default)</SelectItem>
                                        <SelectItem value="ALLOWED_ONLY">Only Show Specific Manga Publishers</SelectItem>
                                        <SelectItem value="HIDE_ALL">Hide All Manga</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
        
                            {config.discover_manga_filter_mode === "ALLOWED_ONLY" && (
                                <div className="space-y-2 animate-in fade-in zoom-in-95 mt-2">
                                    <Label className="text-foreground font-semibold">Allowed Manga Publishers (Comma Separated)</Label>
                                    <textarea
                                        rows={2}
                                        value={config.discover_manga_allowed_publishers || ""}
                                        onChange={e => setConfig({...config, discover_manga_allowed_publishers: e.target.value})}
                                        placeholder="e.g. viz media, shueisha, kodansha"
                                        className="flex min-h-[60px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm text-foreground border-border"
                                    />
                                    <p className="text-[10px] text-muted-foreground">Only manga from these publishers will be allowed on the Discover page. All other manga will be hidden.</p>
                                </div>
                            )}

                            <div className="flex items-center justify-between pt-3 border-t border-border">
                                <div className="space-y-0.5 pr-4">
                                    <Label htmlFor="manga-requests-toggle" className="text-foreground font-semibold">Allow Manga Requests</Label>
                                    <p className="text-[10px] text-muted-foreground">When off, requests detected as manga are rejected before any download automation runs. Library scans and series already in your library are unaffected.</p>
                                </div>
                                <Switch
                                    id="manga-requests-toggle"
                                    checked={config.manga_requests_enabled !== "false"}
                                    onCheckedChange={(c) => setConfig({...config, manga_requests_enabled: c ? "true" : "false"})}
                                />
                            </div>
                        </div>
                    </div>
                    <div className="space-y-4 pt-6 border-t border-border mt-4">
                        <div>
                            <h3 className="text-lg font-bold text-foreground flex items-center gap-2 pb-2">
                                <Database className="w-5 h-5 text-primary" /> Auto-Tagging Logic
                            </h3>
                            <p className="text-[0.8rem] text-muted-foreground">Omnibus automatically detects if an imported series is Manga based on the publisher. Customize the keywords used for detection below.</p>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="flex flex-col gap-2 h-full">
                                <Label className="text-foreground font-semibold">Western Publishers (Comma Separated)</Label>
                                <textarea 
                                    rows={4}
                                    value={config.western_publishers || ""} 
                                    onChange={(e) => setConfig({...config, western_publishers: e.target.value})} 
                                    placeholder="marvel, dc comics, image comics, idw publishing..." 
                                    className="flex-1 min-h-[80px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 text-foreground border-border resize-y"
                                />
                                <p className="text-[10px] text-muted-foreground">These publishers will instantly bypass the AniList API check to save time and reduce rate limits.</p>
                            </div>
                            <div className="flex flex-col gap-2 h-full">
                                <Label className="text-foreground font-semibold">Manga Publishers (Comma Separated)</Label>
                                <textarea 
                                    rows={4}
                                    value={config.manga_publishers || ""} 
                                    onChange={(e) => setConfig({...config, manga_publishers: e.target.value})} 
                                    placeholder="viz media, kodansha, yen press, seven seas, shueisha..." 
                                    className="flex-1 min-h-[80px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 text-foreground border-border resize-y"
                                />
                                <p className="text-[10px] opacity-0 pointer-events-none select-none hidden md:block">Spacer</p>
                            </div>
                        </div>
                        
                        <div className="flex justify-start mt-2">
                            <Button 
                                variant="secondary" 
                                size="sm" 
                                className="font-bold border border-border shadow-sm text-xs"
                                onClick={() => setConfig({
                                    ...config,
                                    manga_publishers: DEFAULT_MANGA_PUBLISHERS.join(", "),
                                    western_publishers: DEFAULT_WESTERN_PUBLISHERS.join(", ")
                                })}
                            >
                                Load Default Lists
                            </Button>
                        </div>
                    </div>
                    {/* CONTENT FILTERING */}
                    <div className="space-y-4 pt-6 border-t border-border mt-6">
                        <Label className="text-base font-bold text-foreground">Content Filtering</Label>
                        
                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border mt-4">
                            <Switch 
                                id="filter-toggle"
                                checked={config.filter_enabled === "true"} 
                                onCheckedChange={(c) => setConfig({...config, filter_enabled: c ? "true" : "false"})} 
                                className="scale-110 sm:scale-100"
                            />
                            <Label htmlFor="filter-toggle" className="cursor-pointer font-bold text-base text-foreground">Enable Content Filtering</Label>
                        </div>
                        
                        <div className="space-y-4 mt-4">
                            <div className="bg-primary/5 p-4 rounded-lg border border-primary/20 flex flex-col sm:flex-row justify-between items-center gap-4 mb-4">
                                <div className="text-sm text-foreground/80">
                                    <strong className="text-primary">Quick Setup:</strong> Load a pre-configured blocklist of common adult/NSFW publishers and keywords.
                                </div>
                                <Button variant="secondary" onClick={applyRecommendedFilters} className="h-12 sm:h-10 w-full sm:w-auto font-bold shrink-0 bg-background border-border shadow-sm text-foreground hover:bg-muted">
                                    Load NSFW Defaults
                                </Button>
                            </div>

                            <div className="grid gap-2">
                                <Label className="text-foreground font-semibold">Blocked Publishers (Comma Separated)</Label>
                                <textarea 
                                    rows={3}
                                    value={config.filter_publishers || ""} 
                                    onChange={e => setConfig({...config, filter_publishers: e.target.value})} 
                                    placeholder="e.g. fakku, yen press, kodansha" 
                                    className="flex min-h-[80px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 text-foreground border-border"
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-foreground font-semibold">Blocked Keywords in Titles (Comma Separated)</Label>
                                <textarea 
                                    rows={3}
                                    value={config.filter_keywords || ""} 
                                    onChange={e => setConfig({...config, filter_keywords: e.target.value})} 
                                    placeholder="e.g. manga, hentai, weekly shonen" 
                                    className="flex min-h-[80px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 text-foreground border-border"
                                />
                            </div>
                            <div className="grid gap-2 mt-4 pt-4 border-t border-border">
                                <div className="bg-primary/5 p-4 rounded-lg border border-primary/20 flex flex-col sm:flex-row justify-between items-center gap-4 mb-2">
                                    <div className="text-sm text-foreground/80">
                                        <strong className="text-primary">Quick Setup:</strong> Load a pre-configured blocklist of common foreign publishers to hide them from Manual Search.
                                    </div>
                                    <Button variant="secondary" onClick={applyForeignFilters} className="h-12 sm:h-10 w-full sm:w-auto font-bold shrink-0 bg-background border-border shadow-sm text-foreground hover:bg-muted">
                                        Load Foreign Defaults
                                    </Button>
                                </div>
                                <Label className="text-foreground font-semibold">Foreign Publisher Blocklist (Comma Separated)</Label>
                                <textarea 
                                    rows={3}
                                    value={config.filter_foreign_publishers || ""} 
                                    onChange={e => setConfig({...config, filter_foreign_publishers: e.target.value})} 
                                    placeholder="e.g. panini espana, urban comics, ecc ediciones" 
                                    className="flex min-h-[80px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 text-foreground border-border"
                                />
                                <p className="text-[10px] text-muted-foreground">These publishers will be hidden from your Manual Search results.</p>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
    </>
  )
}
