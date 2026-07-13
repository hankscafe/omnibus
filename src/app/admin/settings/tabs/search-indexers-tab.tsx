// src/app/admin/settings/tabs/search-indexers-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Cloud, Loader2, RefreshCw, Plus, Zap, Settings, Trash2, Target } from "lucide-react"
import { StatusBox } from "./shared"
import type { SettingsBag } from "./shared"

export function SearchIndexersTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, handleTest, testing, testResults, updateProwlarrCategories,
    customProwlarrCategories, refreshIndexers, refreshing, hasRefreshed, availableIndexers,
    configuredIndexers, openIndexerModal, deleteIndexer, scoringRules, setScoringRules,
    customAcronyms, setCustomAcronyms
  } = s;

  return (
    <>
            {/* --- INDEXER CONFIGURATION CARD --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Cloud className="w-5 h-5 text-primary" /> Indexer & Prowlarr Configuration</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure your Prowlarr connection, search strictness, and manage which indexers to use.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    
                    {/* --- PROWLARR CONNECTION --- */}
                    <div className="grid gap-2"><Label className="text-foreground font-semibold">Prowlarr URL</Label><Input value={config.prowlarr_url} onChange={(e) => setConfig({...config, prowlarr_url: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" /></div>
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">API Key</Label>
                        <Input type="password" value={config.prowlarr_key} onChange={(e) => setConfig({...config, prowlarr_key: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                        <p className="text-[0.8rem] text-muted-foreground">Found in Prowlarr Settings → General → Security → API Key</p>
                    </div>
                    <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('prowlarr')} disabled={!!testing}>
                        {testing === 'prowlarr' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : "Test Connection"}
                    </Button>
                    <StatusBox result={testResults.prowlarr} />

                    {/* --- ADVANCED SEARCH FILTERING --- */}
                    <div className="space-y-4 pt-6 border-t border-border">
                        <div>
                            <h3 className="text-lg font-bold text-foreground">Advanced Search Filtering</h3>
                            <p className="text-[11px] text-muted-foreground mt-1">Configure strictness and blocklists to prevent downloading junk Usenet/Torrent releases.</p>
                        </div>
                        
                        <div className="grid gap-4 bg-muted/30 p-4 rounded-lg border border-border">
                            <div className="grid gap-2">
                                <div className="flex items-center justify-between">
                                    <Label className="text-foreground font-semibold">Match Accuracy Ratio (%)</Label>
                                    <span className="text-xs font-mono text-muted-foreground">{config.filter_match_ratio || "60"}%</span>
                                </div>
                                <input 
                                    type="range" min="10" max="100" step="5" 
                                    value={config.filter_match_ratio || "60"} 
                                    onChange={(e) => setConfig({...config, filter_match_ratio: e.target.value})} 
                                    className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                />
                                <p className="text-[10px] text-muted-foreground">The percentage of words in your request that must match the release title (ignoring release group tags). Lowering this finds more results but increases false positives.</p>
                            </div>

                            <div className="grid gap-2 mt-2">
                                <Label className="text-foreground font-semibold">Junk Words (Comma Separated)</Label>
                                <textarea 
                                    rows={2}
                                    value={config.filter_junk_words || ""} 
                                    onChange={e => setConfig({...config, filter_junk_words: e.target.value})} 
                                    placeholder="e.g. preview, sample, ashcan" 
                                    className="flex min-h-[60px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary text-foreground border-border"
                                />
                                <p className="text-[10px] text-muted-foreground">Releases containing these words will be instantly rejected during auto-search.</p>
                            </div>

                            <div className="grid gap-2 mt-2">
                                <Label className="text-foreground font-semibold">Blocked Release Groups (Comma Separated)</Label>
                                <textarea 
                                    rows={2}
                                    value={config.filter_exclude_groups || ""} 
                                    onChange={e => setConfig({...config, filter_exclude_groups: e.target.value})} 
                                    placeholder="e.g. Empire, Minutemen, dcp" 
                                    className="flex min-h-[60px] w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary text-foreground border-border"
                                />
                                <p className="text-[10px] text-muted-foreground">Releases containing these groups/tags will be rejected.</p>
                            </div>
                        </div>
                    </div>
                    
                    {/* --- CATEGORIES --- */}
                    <div className="space-y-4 pt-6 border-t border-border">
                        <div>
                            <h3 className="text-lg font-bold text-foreground">Search Categories (Torznab IDs)</h3>
                            <p className="text-[11px] text-muted-foreground mt-1">Select the categories Prowlarr should use when searching. <strong>7030</strong> is required for standard comic indexers.</p>
                        </div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border border-border rounded-lg p-4 bg-muted/20">
                            <div className="space-y-3">
                                <Label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Books / Comics (7000s)</Label>
                                <div className="grid gap-3">
                                    {[
                                        { id: '7000', label: '7000 - Books' },
                                        { id: '7010', label: '7010 - Books/Mags' },
                                        { id: '7020', label: '7020 - Books/EBook' },
                                        { id: '7030', label: '7030 - Books/Comics' }
                                    ].map(cat => (
                                        <div key={cat.id} className="flex items-center space-x-3 bg-background p-2 rounded border border-border shadow-sm">
                                            <Switch 
                                                id={`cat-${cat.id}`}
                                                checked={(config.prowlarr_categories || "").split(',').map((c: string) => c.trim()).includes(cat.id)}
                                                onCheckedChange={(checked) => updateProwlarrCategories(cat.id, checked)}
                                                className="scale-90 sm:scale-100 ml-1"
                                            />
                                            <Label htmlFor={`cat-${cat.id}`} className="cursor-pointer font-bold text-sm text-foreground">{cat.label}</Label>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            
                            <div className="space-y-6">
                                <div className="space-y-3">
                                    <Label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Other / Misc (8000s)</Label>
                                    <div className="flex items-center space-x-3 bg-background p-2 rounded border border-border shadow-sm">
                                        <Switch 
                                            id="cat-8000"
                                            checked={(config.prowlarr_categories || "").split(',').map((c: string) => c.trim()).includes("8000")}
                                            onCheckedChange={(checked) => updateProwlarrCategories("8000", checked)}
                                            className="scale-90 sm:scale-100 ml-1"
                                        />
                                        <Label htmlFor="cat-8000" className="cursor-pointer font-bold text-sm text-foreground">8000 - Other</Label>
                                    </div>
                                </div>
                                
                                <div className="space-y-3 pt-2">
                                    <Label className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Custom Categories</Label>
                                    <Input 
                                        placeholder="e.g. 5070, 2000" 
                                        value={customProwlarrCategories} 
                                        onChange={(e) => updateProwlarrCategories(undefined, undefined, e.target.value)} 
                                        className="h-10 bg-background border-border text-foreground text-sm font-mono"
                                    />
                                    <p className="text-[10px] text-muted-foreground">Comma-separated custom Newznab/Torznab IDs.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* --- INDEXERS LIST --- */}
                    <div className="space-y-4 pt-6 border-t border-border mt-4">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                            <h3 className="text-lg font-bold text-foreground">Available Indexers</h3>
                            <Button variant="secondary" size="sm" onClick={refreshIndexers} disabled={refreshing} className="w-full sm:w-auto h-12 sm:h-9 font-bold bg-muted hover:bg-muted/80 text-foreground transition-colors">
                                {refreshing ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <RefreshCw className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Refresh List
                            </Button>
                        </div>

                        {!hasRefreshed && availableIndexers.length === 0 ? (
                            <div className="border-2 border-dashed border-border rounded-lg p-10 text-center text-muted-foreground">Click "Refresh List" to load available indexers from Prowlarr.</div>
                        ) : (
                            <div className="grid gap-3 max-h-[300px] overflow-y-auto pr-2 border border-border rounded-lg p-3 sm:p-4 bg-muted/30">
                                {availableIndexers.map(idx => (
                                    <div key={idx.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 border border-border rounded-lg bg-background shadow-sm gap-3">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="font-bold text-foreground truncate">{idx.name}</span>
                                            <Badge variant="outline" className="text-[10px] capitalize border-primary/30 text-primary shrink-0">{idx.protocol}</Badge>
                                        </div>
                                        {configuredIndexers.some(c => c.id === idx.id) ? (
                                            <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800/50 h-10 sm:h-auto flex items-center justify-center">Already Added</Badge>
                                        ) : (
                                            <Button size="sm" onClick={() => openIndexerModal(idx)} className="h-10 sm:h-8 hover:scale-105 transition-transform bg-primary hover:bg-primary/90 text-primary-foreground"><Plus className="w-4 h-4 sm:w-3 sm:h-3 mr-1"/> Add</Button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <h3 className="text-lg font-bold pt-6 text-primary flex items-center gap-2">
                            <Zap className="w-5 h-5"/> Configured Indexers
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {configuredIndexers.map(idx => (
                                <Card key={idx.id} className="p-4 border-primary/20 bg-primary/5 shadow-sm">
                                    <div className="flex justify-between items-start mb-2">
                                        <div className="min-w-0 flex-1 pr-2">
                                            <p className="font-bold text-sm truncate text-foreground">{idx.name}</p>
                                            <Badge variant="secondary" className="text-[9px] uppercase tracking-wider bg-primary/10 text-primary mt-1">{idx.protocol || "torrent"}</Badge>
                                        </div>
                                        <div className="flex gap-1 shrink-0">
                                            <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:bg-primary/10 text-primary" onClick={() => openIndexerModal(idx, true)}><Settings className="h-5 h-5 sm:h-4 sm:w-4"/></Button>
                                            <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => deleteIndexer(idx.id)}><Trash2 className="h-5 h-5 sm:h-4 sm:w-4"/></Button>
                                        </div>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground border-t border-border pt-2 uppercase tracking-tight">Priority: {idx.priority} • RSS: {idx.rss ? "Enabled" : "Disabled"}</div>
                                </Card>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Target className="w-5 h-5 text-primary" /> Release Scoring & Custom Formats</CardTitle>
                    <CardDescription className="text-muted-foreground">Assign point values to specific terms to prioritize or penalize releases during auto-search.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg flex flex-col gap-2">
                        <p className="text-sm font-bold text-foreground">How Scoring Works:</p>
                        <ul className="text-[11px] text-muted-foreground list-disc list-inside ml-4 space-y-1">
                            <li>All releases start with a base score equal to their <strong className="text-foreground">Seeders</strong>.</li>
                            <li>If a release title contains a term defined below, the points are added (or subtracted) from that base score.</li>
                            <li>Omnibus automatically downloads the release with the highest final score.</li>
                            <li>Negative scores act as penalties, but will not strictly block a release if it is the only option (use the Junk Filter to strictly block releases).</li>
                        </ul>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <Label className="text-base font-bold text-foreground">Custom Scoring Rules</Label>
                        <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => setScoringRules([{ id: `tmp_${Math.random()}`, term: "", score: 100 }, ...scoringRules])} 
                            className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground"
                        >
                            <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-1 text-primary"/> Add Rule
                        </Button>
                    </div>

                    <div className="space-y-3">
                        {scoringRules.length === 0 && <p className="text-sm text-muted-foreground italic bg-muted/20 p-4 rounded-md border border-border">No scoring rules defined. Releases will be sorted entirely by seeder count.</p>}
                        {scoringRules.map((rule, i) => (
                            <div key={rule.id} className="flex flex-col sm:flex-row gap-2 animate-in fade-in slide-in-from-top-1 bg-muted/30 p-2 rounded-md sm:bg-transparent sm:p-0 sm:rounded-none sm:border-0 border border-border">
                                <Input 
                                    placeholder="Match Term (e.g. empire, .cbz, webrip)" 
                                    value={rule.term} 
                                    onChange={e => { const r = [...scoringRules]; r[i].term = e.target.value; setScoringRules(r); }} 
                                    className="h-12 sm:h-10 w-full sm:w-1/2 bg-background border-border font-mono text-sm text-foreground" 
                                />
                                <div className="flex gap-2 w-full sm:w-1/2">
                                  <div className="relative flex-1">
                                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs font-bold font-mono">Pts:</span>
                                      <Input 
                                          type="number"
                                          placeholder="100" 
                                          value={rule.score} 
                                          onChange={e => { const r = [...scoringRules]; r[i].score = parseInt(e.target.value) || 0; setScoringRules(r); }} 
                                          className="h-12 sm:h-10 w-full bg-background border-border font-mono text-sm text-foreground pl-10" 
                                      />
                                  </div>
                                  <Button variant="ghost" size="icon" onClick={() => setScoringRules(scoringRules.filter(r => r.id !== rule.id))} className="h-12 w-12 sm:h-10 sm:w-10 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200">
                                      <Trash2 className="h-5 h-5 sm:h-4 sm:w-4"/>
                                  </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                    {/* Acronym Customization */}
                    <div className="space-y-4 pt-6 border-t border-border mt-6">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div>
                                <Label className="text-base font-bold text-foreground">Search Acronym Expansion</Label>
                                <p className="text-[11px] text-muted-foreground mt-1">Automatically expand acronyms during automated fuzzy searches (e.g., "TMNT" &rarr; "Teenage Mutant Ninja Turtles").</p>
                            </div>
                            <Button variant="outline" size="sm" onClick={() => setCustomAcronyms([...customAcronyms, { id: `tmp_${Math.random()}`, key: "", value: "" }])} className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground">
                                <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-1 text-primary"/> Add Acronym
                            </Button>
                        </div>
                        
                        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                            {customAcronyms.length === 0 && <p className="text-sm text-muted-foreground italic bg-muted/20 p-4 rounded-md border border-border">No custom acronyms defined. System defaults will be used.</p>}
                            {customAcronyms.map((ac, i) => (
                                <div key={ac.id} className="flex flex-col sm:flex-row gap-2 animate-in fade-in slide-in-from-top-1 bg-muted/30 p-2 rounded-md sm:bg-transparent sm:p-0 sm:rounded-none sm:border-0 border border-border">
                                    <Input 
                                        placeholder="Acronym (e.g. tmnt)" 
                                        value={ac.key} 
                                        onChange={e => { const a = [...customAcronyms]; a[i].key = e.target.value; setCustomAcronyms(a); }} 
                                        className="h-12 sm:h-10 w-full sm:w-1/3 bg-background border-border font-mono text-sm text-foreground" 
                                    />
                                    <div className="flex gap-2 w-full">
                                      <Input 
                                          placeholder="Full Expansion (e.g. teenage mutant ninja turtles)" 
                                          value={ac.value} 
                                          onChange={e => { const a = [...customAcronyms]; a[i].value = e.target.value; setCustomAcronyms(a); }} 
                                          className="h-12 sm:h-10 flex-1 bg-background border-border font-mono text-sm text-foreground" 
                                      />
                                      <Button variant="ghost" size="icon" onClick={() => setCustomAcronyms(customAcronyms.filter(c => c.id !== ac.id))} className="h-12 w-12 sm:h-10 sm:w-10 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200"><Trash2 className="h-5 h-5 sm:h-4 sm:w-4"/></Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>
    </>
  )
}
