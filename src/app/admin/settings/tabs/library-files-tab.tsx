// src/app/admin/settings/tabs/library-files-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { HardDrive, Trash2, Plus, Loader2, CheckCircle2, RotateCcw } from "lucide-react"
import { StatusBox } from "./shared"
import type { SettingsBag } from "./shared"

export function LibraryFilesTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, configuredLibraries, addLibrary, removeLibrary, updateLibrary,
    setLibraryDefault, handleTest, testing, testResults, handleRestoreNamingDefaults
  } = s;

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
                        {configuredLibraries.map((lib, i) => (
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
                                    <Input value={lib.path} onChange={e => updateLibrary(lib.id, 'path', e.target.value)} placeholder={typeof window !== 'undefined' && navigator.platform.indexOf('Win') > -1 ? "C:\\Comics\\Library" : "/library"} className="h-12 sm:h-10 font-mono bg-background border-border text-foreground text-sm" />
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
                            placeholder={typeof window !== 'undefined' && navigator.platform.indexOf('Win') > -1 ? "C:\\Downloads\\Comics" : "/downloads"} 
                            className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                        />
                        <p className="text-[11px] text-muted-foreground">The folder Omnibus scans for finished downloads before routing them into your libraries.</p>
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
                                    Available tags: <code className="bg-muted px-1 rounded border border-border">{"{Publisher}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Series}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Year}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{VolumeYear}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{IssueYear}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Issue}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{IssueTitle}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{UniverseName}"}</code>
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
                                <p className="text-[10px] text-muted-foreground">Use slashes (/) to create sub-folders. Tokens: {`{Publisher} {Series} {Year} {VolumeYear} {UniverseName} {SeriesGroup}`}. {`{SeriesGroup}`} groups related series under one umbrella folder (e.g. {`{SeriesGroup}/{Series} ({Year})`}).</p>
                            </div>
                            
                            <div className="space-y-2">
                                <Label className="text-foreground font-semibold">Standard Comic File Format</Label>
                                <Input 
                                    value={config.file_naming_pattern || "{Series} #{Issue}"} 
                                    onChange={e => setConfig({...config, file_naming_pattern: e.target.value})} 
                                    placeholder="{Series} #{Issue}"
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Applied to standard Western comics. Tokens: {`{Series} {Issue} {IssueTitle} {IssueYear} {Year} {Publisher} {UniverseName} {SeriesGroup}`}.</p>
                            </div>

                            <div className="space-y-2 md:col-span-2 lg:col-span-1">
                                <Label className="text-foreground font-semibold">Manga File Format</Label>
                                <Input 
                                    value={config.manga_file_naming_pattern || "{Series} Vol. {Issue}"} 
                                    onChange={e => setConfig({...config, manga_file_naming_pattern: e.target.value})} 
                                    placeholder="{Series} Vol. {Issue}" 
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Applied to items flagged as Manga.</p>
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
                                    <span className="text-primary break-all">
                                        {(config.folder_naming_pattern || "{Publisher}/{Series} ({Year})")
                                            .replace(/{Publisher}/gi, "Marvel")
                                            .replace(/{Series}/gi, "Amazing Spider-Man")
                                            .replace(/{Year}/gi, "2022")
                                            .replace(/{VolumeYear}/gi, "2022")
                                            .replace(/{IssueYear}/gi, "2022")
                                            .replace(/{UniverseName}/gi, "Earth-616")
                                            .replace(/{SeriesGroup}/gi, "Spider-Man")
                                            .replace(/\(\s*\)/g, '')
                                            .replace(/\[\s*\]/g, '')
                                            .replace(/\s+/g, ' ')
                                            .trim()}
                                    </span>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                                    <span className="text-muted-foreground w-28 shrink-0">Standard Comic:</span>
                                    <span className="text-primary break-all">
                                        {(config.file_naming_pattern || "{Series} #{Issue}")
                                            .replace(/{Publisher}/gi, "Marvel")
                                            .replace(/{Series}/gi, "Amazing Spider-Man")
                                            .replace(/{Year}/gi, "2022")
                                            .replace(/{VolumeYear}/gi, "2022")
                                            .replace(/{IssueYear}/gi, "2022")
                                            .replace(/{UniverseName}/gi, "Earth-616")
                                            .replace(/{SeriesGroup}/gi, "Spider-Man")
                                            .replace(/{Issue}/gi, "01")
                                            .replace(/\(\s*\)/g, '')
                                            .replace(/\[\s*\]/g, '')
                                            .replace(/\s+/g, ' ')
                                            .trim()}.cbz
                                    </span>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                                    <span className="text-muted-foreground w-28 shrink-0">Manga:</span>
                                    <span className="text-primary break-all">
                                        {(config.manga_file_naming_pattern || "{Series} Vol. {Issue}")
                                            .replace(/{Publisher}/gi, "Shueisha")
                                            .replace(/{Series}/gi, "Chainsaw Man")
                                            .replace(/{Year}/gi, "2018")
                                            .replace(/{VolumeYear}/gi, "2018")
                                            .replace(/{IssueYear}/gi, "2018")
                                            .replace(/{UniverseName}/gi, "")
                                            .replace(/{SeriesGroup}/gi, "Chainsaw Man")
                                            .replace(/{Issue}/gi, "01")
                                            .replace(/\(\s*\)/g, '')
                                            .replace(/\[\s*\]/g, '')
                                            .replace(/\s+/g, ' ')
                                            .trim()}.cbz
                                    </span>
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
                                        Converts .cbr/.rar/.cb7 archives to .cbz on import, on match, and on the scheduled sweep (recommended — CBZ reads fastest and works everywhere). When off, CBR/RAR files stay untouched and are read natively through the engine; page loads can be slightly slower, .cb7 still needs conversion to be readable, and metadata embedding skips them (ComicInfo.xml can only be written into .cbz — RAR archives are read-only). The manual CBR Auto-Converter job keeps working either way.
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
