// src/app/admin/settings/tabs/library-files-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HardDrive, Trash2, Plus, Loader2, CheckCircle2, RotateCcw } from "lucide-react"
import { StatusBox } from "./shared"
import type { SettingsBag } from "./shared"
import { issueFileName, issuePaddingFromSetting, seriesFolderSegments, type NamingInput } from "@/lib/utils/naming"

// Sample values for the live previews. The previews run the same naming rules (naming.ts) as every
// path that names a file, so what they show is what an import, a match or Standardize will write.
const COMIC_SAMPLE: NamingInput = {
  publisher: "Marvel", imprint: "Marvel MAX", series: "Amazing Spider-Man", seriesYear: 2022,
  issueNumber: "1", releaseDate: "2022-04-06", issueTitle: "The Hunt", universe: "Earth-616", seriesGroup: "Spider-Man",
}
const MANGA_SAMPLE: NamingInput = {
  publisher: "Shueisha", imprint: "Jump Comics", series: "Chainsaw Man", seriesYear: 2018,
  issueNumber: "1", releaseDate: "2018-12-04", issueTitle: "Dog & Chainsaw", seriesGroup: "Chainsaw Man",
}

export function LibraryFilesTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, configuredLibraries, addLibrary, removeLibrary, updateLibrary,
    setLibraryDefault, handleTest, testing, testResults, handleRestoreNamingDefaults
  } = s;

  const padding = issuePaddingFromSetting(config.issue_number_padding);
  const folderPreview = seriesFolderSegments(config.folder_naming_pattern || "{Publisher}/{Series} ({Year})", COMIC_SAMPLE)?.join("/")
    ?? "(no folder inside the library - check the pattern)";
  const filePreview = (pattern: string, sample: NamingInput) => {
    const name = issueFileName(pattern, sample, padding);
    return name ? `${name}.cbz` : "(no file name - check the pattern)";
  };

  return (
    <>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground">
                        <HardDrive className="w-5 h-5 text-primary" /> Root Library Folders
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">Manage where Omnibus organizes your downloaded comics. You can add infinite root folders.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                    
                    <div className="space-y-4">
                        {configuredLibraries.map((lib) => (
                            <div key={lib.id} className={`grid gap-6 md:grid-cols-[1fr_2fr] p-4 rounded-lg border relative group transition-colors ${lib.isDefault ? 'border-primary/50 bg-primary/5 shadow-sm' : 'bg-muted/30 border-border'}`}>
                                <div className="space-y-3">
                                    <div className="space-y-1.5">
                                        <Label className="text-base sm:text-lg font-bold text-foreground">Library Name</Label>
                                        <Input value={lib.name} onChange={e => updateLibrary(lib.id, 'name', e.target.value)} placeholder="e.g. Main Comics" className="h-12 sm:h-10 font-bold bg-background border-border text-foreground" />
                                    </div>
                                    <div className="flex flex-col gap-2 pt-1">
                                        <div className="flex items-center gap-2">
                                            <Switch checked={lib.isManga} onCheckedChange={v => { updateLibrary(lib.id, 'isManga', v); if(lib.isDefault) setLibraryDefault(lib.id, v); }} className="scale-110 sm:scale-100" />
                                            <Label className="cursor-pointer font-bold text-sm text-foreground">Manga Destination</Label>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Switch checked={lib.isDefault} onCheckedChange={v => v && setLibraryDefault(lib.id, lib.isManga)} className="scale-110 sm:scale-100" />
                                            <Label className="cursor-pointer font-bold text-sm text-foreground">Default for Auto-Import</Label>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Switch checked={!!lib.defaultAccess} onCheckedChange={v => updateLibrary(lib.id, 'defaultAccess', v)} className="scale-110 sm:scale-100" />
                                            <Label className="cursor-pointer font-bold text-sm text-foreground" title="Every user is automatically granted access to this library, and new users are seeded with it.">Auto-grant to all users</Label>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-base sm:text-lg font-bold text-primary">Root Path</Label>
                                    <Input value={lib.path} onChange={e => updateLibrary(lib.id, 'path', e.target.value)} placeholder="/data/comics" className="h-12 sm:h-10 font-mono bg-background border-border text-foreground text-sm" />
                                    <p className="text-[11px] text-muted-foreground">The folder as Omnibus sees it. In Docker, use the container side of a volume in your compose file (e.g. /data/comics), not a Windows path like C:\Comics.</p>
                                </div>
                                <Button variant="ghost" size="icon" className="absolute top-2 right-2 h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-opacity opacity-100 sm:opacity-0 group-hover:opacity-100" onClick={() => removeLibrary(lib.id)}>
                                    <Trash2 className="w-5 h-5 sm:h-4 sm:w-4" />
                                </Button>
                            </div>
                        ))}
                        
                        <Button variant="outline" className="w-full h-12 sm:h-10 border-dashed border-2 border-border text-muted-foreground hover:text-foreground font-bold hover:bg-muted/50" onClick={addLibrary}>
                            <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2" /> Add Library Route
                        </Button>
                    </div>

                    <div className="grid gap-2 pt-6 border-t border-border">
                        <Label className="text-foreground font-semibold">Download Scan Root</Label>
                        <Input 
                            value={config.download_path} 
                            onChange={e => setConfig({...config, download_path: e.target.value})} 
                            placeholder="/data/downloads"
                            className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                        />
                        <p className="text-[11px] text-muted-foreground">The folder Omnibus scans for finished downloads before routing them into your libraries - like the library folders, the path as Omnibus sees it inside its container.</p>
                    </div>

                    <div className="border-t border-border my-4" />
                    <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('paths')} disabled={!!testing}>
                        {testing === 'paths' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle2 className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test File Permissions
                    </Button>
                    <StatusBox result={testResults.paths} />
                    <div className="grid gap-4 pt-6 border-t border-border">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div>
                                <h3 className="text-lg font-bold text-foreground">Media Naming Conventions</h3>
                                <p className="text-[11px] text-muted-foreground mt-1">
                                    Customize how Omnibus names your folders and files during imports. 
                                    Available tags: <code className="bg-muted px-1 rounded border border-border">{"{Publisher}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Imprint}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Series}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Year}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{VolumeYear}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{IssueYear}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Issue}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{IssueTitle}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{UniverseName}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{SeriesGroup}"}</code>
                                </p>
                            </div>
                            <Button 
                                variant="outline" 
                                type="button"
                                onClick={handleRestoreNamingDefaults} 
                                className="text-orange-600 border-orange-200 hover:bg-orange-50 dark:border-orange-900/50 dark:hover:bg-orange-900/20 shadow-sm font-bold shrink-0 w-full sm:w-auto h-12 sm:h-10"
                            >
                                <RotateCcw className="w-4 h-4 mr-2" /> 
                                Restore Defaults
                            </Button>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <Label className="text-foreground font-semibold">Series Folder Format</Label>
                                <Input 
                                    value={config.folder_naming_pattern || "{Publisher}/{Series} ({Year})"} 
                                    onChange={e => setConfig({...config, folder_naming_pattern: e.target.value})} 
                                    placeholder="{Publisher}/{Series} ({Year})"
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Use slashes (/) to create sub-folders. Tokens: {`{Publisher} {Imprint} {Series} {Year} {VolumeYear} {UniverseName} {SeriesGroup}`}. A blank imprint removes its folder tier. {`{SeriesGroup}`} groups related series under one umbrella folder (e.g. {`{SeriesGroup}/{Series} ({Year})`}).</p>
                            </div>
                            
                            <div className="space-y-2">
                                <Label className="text-foreground font-semibold">Standard Comic File Format</Label>
                                <Input 
                                    value={config.file_naming_pattern || "{Series} #{Issue}"} 
                                    onChange={e => setConfig({...config, file_naming_pattern: e.target.value})} 
                                    placeholder="{Series} #{Issue}"
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Applied to standard Western comics. Tokens: {`{Series} {Issue} {IssueTitle} {IssueYear} {Year} {Publisher} {Imprint} {UniverseName} {SeriesGroup}`}.</p>
                            </div>

                            <div className="space-y-2 md:col-span-2 lg:col-span-1">
                                <Label className="text-foreground font-semibold">Manga File Format</Label>
                                <Input 
                                    value={config.manga_file_naming_pattern || "{Series} Vol. {Issue}"} 
                                    onChange={e => setConfig({...config, manga_file_naming_pattern: e.target.value})} 
                                    placeholder="{Series} Vol. {Issue}" 
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Applied to items flagged as Manga. The same folder and metadata tokens, including {`{Imprint}`}, are available.</p>
                            </div>

                            {/* #203 COLLECTED: TPB naming conventions vary far more than annuals
                                (v01 / Vol. 1 / the collection's own title), so this one is a real
                                setting rather than the fixed pattern annuals use. */}
                            <div className="space-y-2 md:col-span-2 lg:col-span-1">
                                <Label className="text-foreground font-semibold">Collected Edition Format</Label>
                                <Input
                                    value={config.collected_file_naming_pattern || "{Series} Vol. {Issue} ({IssueYear})"}
                                    onChange={e => setConfig({...config, collected_file_naming_pattern: e.target.value})}
                                    placeholder="{Series} Vol. {Issue} ({IssueYear})"
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Applied to trades and omnibuses attached to a series as collected editions. The same file tokens, including {`{Imprint}`}, are available. Their number is whatever you set, so it doubles as reading order.</p>
                            </div>

                            {/* #244: one padding rule for every file name Omnibus writes. */}
                            <div className="space-y-2 md:col-span-2 lg:col-span-1">
                                <Label htmlFor="issue_number_padding" className="text-foreground font-semibold">Issue Number Padding</Label>
                                <Select value={padding} onValueChange={(v) => setConfig({ ...config, issue_number_padding: v })}>
                                    <SelectTrigger id="issue_number_padding" className="h-12 sm:h-10 bg-muted/30 border-border text-foreground">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="3">3 digits (#001)</SelectItem>
                                        <SelectItem value="2">2 digits (#01)</SelectItem>
                                        <SelectItem value="none">None (#1)</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-[10px] text-muted-foreground">How {`{Issue}`} is written in every file name: downloads, the watched folder, the Smart Matcher and Standardize. Decimals and letters keep their place (#001.5, #001A). Changing this renames your files the next time you run Standardize.</p>
                            </div>
                        </div>

                        {/* --- LIVE PREVIEW BOX --- */}
                        <div className="bg-muted/30 p-4 rounded-lg border border-border space-y-3 mt-2">
                            <Label className="text-xs font-bold text-foreground uppercase tracking-widest flex items-center gap-2 mb-3">
                                Live Example Previews
                            </Label>
                            <div className="grid gap-3 text-xs font-mono">
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                                    <span className="text-muted-foreground w-28 shrink-0">Folder:</span>
                                    <span className="text-primary break-all">{folderPreview}</span>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                                    <span className="text-muted-foreground w-28 shrink-0">Standard Comic:</span>
                                    <span className="text-primary break-all">{filePreview(config.file_naming_pattern || "{Series} #{Issue}", COMIC_SAMPLE)}</span>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                                    <span className="text-muted-foreground w-28 shrink-0">Manga:</span>
                                    <span className="text-primary break-all">{filePreview(config.manga_file_naming_pattern || "{Series} Vol. {Issue}", MANGA_SAMPLE)}</span>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                                    <span className="text-muted-foreground w-28 shrink-0">Collected Edition:</span>
                                    <span className="text-primary break-all">{filePreview(config.collected_file_naming_pattern || "{Series} Vol. {Issue} ({IssueYear})", COMIC_SAMPLE)}</span>
                                </div>
                            </div>
                        </div>

                        {/* --- IMAGE COMPRESSION UI --- */}
                        <div className="grid gap-4 pt-6 border-t border-border mt-4">
                            <div>
                                <h3 className="text-lg font-bold text-foreground">Archive Compression (WEBP)</h3>
                                <p className="text-[11px] text-muted-foreground mt-1">
                                    Convert heavy JPEGs and PNGs to WEBP during CBR to CBZ conversions and when running the Repack tool. This saves massive amounts of disk space and significantly increases web reader performance.
                                </p>
                            </div>
    
                            <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                                <Switch
                                    id="cbr-conversion-toggle"
                                    checked={config.cbr_conversion_enabled !== "false"}
                                    onCheckedChange={(c) => setConfig({...config, cbr_conversion_enabled: c ? "true" : "false"})}
                                    className="scale-110 sm:scale-100"
                                />
                                <div className="grid gap-1 ml-2">
                                    <Label htmlFor="cbr-conversion-toggle" className="cursor-pointer font-bold text-base text-foreground">
                                        Auto-Convert CBR/RAR to CBZ
                                    </Label>
                                    <p className="text-[11px] text-muted-foreground">
                                        Converts .cbr/.rar/.cb7 archives to .cbz on import, on match, and on the scheduled sweep (recommended — CBZ reads fastest and works everywhere). When off, CBR/RAR/CB7 files stay untouched and are read natively through the engine; page loads can be slightly slower, and metadata embedding skips them (ComicInfo.xml can only be written into .cbz — RAR and 7z archives are read-only here). The manual CBR Auto-Converter job keeps working either way.
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border w-fit">
                                <Switch
                                    id="webp-toggle"
                                    checked={config.convert_to_webp === "true"}
                                    onCheckedChange={(c) => setConfig({...config, convert_to_webp: c ? "true" : "false"})}
                                />
                                <Label htmlFor="webp-toggle" className="cursor-pointer font-bold text-base text-foreground">Convert images to WEBP</Label>
                            </div>

                            {config.convert_to_webp === "true" && (
                                <div className="grid gap-2 max-w-sm">
                                    <div className="flex items-center justify-between">
                                        <Label className="text-foreground font-semibold">WEBP Quality</Label>
                                        <span className="text-xs font-mono text-muted-foreground">{config.webp_quality || "80"}%</span>
                                    </div>
                                    <input 
                                        type="range" min="10" max="100" step="5" 
                                        value={config.webp_quality || "80"} 
                                        onChange={(e) => setConfig({...config, webp_quality: e.target.value})} 
                                        className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                                    />
                                    <p className="text-[10px] text-muted-foreground">80% provides excellent visual quality while heavily reducing file size.</p>
                                </div>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>
    </>
  )
}
