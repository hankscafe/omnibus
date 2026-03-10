"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  FolderOpen, HardDrive, Save, Cloud, CheckCircle, Loader2, Key, ArrowLeft, 
  XCircle, RefreshCw, Plus, Settings, Shield, Trash2, Zap, Download, Filter, Webhook, Copy, Bell, Pencil, AlertCircle, Send, Fingerprint
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"

// --- Types ---
interface IndexerConfig { id: number; name: string; priority: number; seedTime: number; seedRatio: number; rss: boolean; protocol: string; }
interface CustomHeader { key: string; value: string; }
interface AcronymConfig { key: string; value: string; }
interface ClientConfig { 
    id: string; 
    name: string; 
    type: 'qbit' | 'sab' | 'deluge' | 'nzbget'; 
    protocol: 'Torrent' | 'Usenet'; 
    url: string; 
    user: string; 
    pass: string; 
    apiKey?: string; 
    category?: string;
    remotePath?: string; 
    localPath?: string;
}
interface WebhookConfig {
    id: string;
    name: string;
    url: string;
    events: string[];
    isActive: boolean;
}

const RECOMMENDED_PUBLISHERS = "hakusensha, shueisha, kodansha, shogakukan, square enix, yen press, viz media, seven seas, fakku, project-h, denpa, irodori, eros comix, tokyopop, kadokawa, futabasha, houbunsha, takeshobo, mag garden, akita shoten, shonen gahosha, nihon bungeisha, coamix, gee-whiz, ghost ship, j-novel club, suiseisha, shinchosha, ascii media works, ichijinsha";
const RECOMMENDED_KEYWORDS = "weekly young, young animal, weekly shonen, monthly shonen, gee-whiz, manga, hentai, doujinshi, shoujo, seinen, shojo, josei, gaze, lustiges taschenbuch enten-edition, les tuniques bleues, big comic superior, Creature Girls: A Hands-On Field Journal In Another World, Young King Bull, weekly playboy, big comic spirits, Young Champion Retsu, Big Comic Zōkan, Monthly Young Magazine, Comic Zenon, shonen sunday s, Chira Chiller";

// --- UPDATED DISCORD EVENTS LIST ---
const DISCORD_EVENTS = [
  { id: "pending_request", label: "Pending Request", desc: "Includes requester username, cover image, and synopsis." },
  { id: "request_approved", label: "Request Approved", desc: "Includes admin username, cover image, and synopsis." },
  { id: "comic_available", label: "Comic Available", desc: "Includes requester username, cover image, and synopsis." },
  { id: "download_failed", label: "Comic Download Failed", desc: "Alerts when Prowlarr or the download client fails." },
  { id: "pending_account", label: "Pending Account", desc: "Includes new user's username, email, and registration date." },
  { id: "account_approved", label: "Account Approved", desc: "Alerts when an admin approves a new user account." },
  { id: "system_alert", label: "System Health", desc: "Triggers for disk space warnings or critical errors." },
  { id: "update_available", label: "System Update Available", desc: "Alerts when a new version of Omnibus is published to GitHub." },
  { id: "library_cleanup", label: "Library Cleanup", desc: "Triggers when a series is deleted, noting if files were removed from the disk." },
  { id: "metadata_match", label: "Metadata Matched", desc: "Alerts when a series is successfully matched to ComicVine IDs." },
  { id: "job_db_backup", label: "Database Backup Complete", desc: "Notifies when the automated database backup finishes." },
  { id: "job_library_scan", label: "Library Auto-Scan Complete", desc: "Notifies when the automated library scan finishes." },
  { id: "job_metadata_sync", label: "Deep Metadata Sync Complete", desc: "Notifies when the deep metadata sync finishes processing." },
  { id: "job_issue_monitor", label: "New Issue Monitor Complete", desc: "Notifies when the monitor successfully checks for new releases." },
  { id: "job_discover_sync", label: "Discover Sync Complete", desc: "Notifies when the discover timeline and popular comics refresh." },
  { id: "job_diagnostics", label: "System Diagnostics Complete", desc: "Notifies when automated system diagnostics have been run." }
];

export default function SettingsPage() {
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  
  const [testResults, setTestResults] = useState<{ [key: string]: { success: boolean, text: string } | null }>({
    comicvine: null, prowlarr: null, clients: null, paths: null, mapping: null, webhooks: null
  })
  
  const [refreshing, setRefreshing] = useState(false)
  const [availableIndexers, setAvailableIndexers] = useState<any[]>([])
  const [hasRefreshed, setHasRefreshed] = useState(false)
  const [configuredIndexers, setConfiguredIndexers] = useState<IndexerConfig[]>([])
  const [indexerModalOpen, setIndexerModalOpen] = useState(false)
  const [editingIndexer, setEditingIndexer] = useState<IndexerConfig>({ 
    id: 0, name: "", priority: 1, seedTime: 0, seedRatio: 0, rss: false, protocol: "torrent" 
  })

  const [configuredClients, setConfiguredClients] = useState<ClientConfig[]>([])
  const [clientModalOpen, setClientModalOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<ClientConfig | null>(null)

  // Webhooks State
  const [configuredWebhooks, setConfiguredWebhooks] = useState<WebhookConfig[]>([])
  const [webhookModalOpen, setWebhookModalOpen] = useState(false)
  const [editingWebhook, setEditingWebhook] = useState<WebhookConfig | null>(null)

  const [customHeaders, setCustomHeaders] = useState<CustomHeader[]>([])
  const [customAcronyms, setCustomAcronyms] = useState<AcronymConfig[]>([]) 
  const { toast } = useToast()
  
  const [config, setConfig] = useState<any>({
    prowlarr_url: "", prowlarr_key: "", download_path: "", library_path: "", cv_api_key: "",
    remote_path_mapping: "", local_path_mapping: "",
    filter_enabled: "false", filter_publishers: "", filter_keywords: "",
    omnibus_api_key: "", download_retry_delay: "5", 
    manga_library_path: "",
    oidc_enabled: "false", oidc_issuer: "", oidc_client_id: "", oidc_client_secret: ""
  })

  useEffect(() => {
    fetch('/api/admin/config').then(res => res.json()).then(data => {
        const newConfig: any = { ...config }
        let hasAcronyms = false;

        if (Array.isArray(data)) {
            data.forEach((item: any) => { 
                if (item.key === 'prowlarr_indexers_config') {
                    try { setConfiguredIndexers(JSON.parse(item.value)) } catch (e) { setConfiguredIndexers([]) }
                } else if (item.key === 'download_clients_config') {
                    try { setConfiguredClients(JSON.parse(item.value)) } catch (e) { setConfiguredClients([]) }
                } else if (item.key === 'custom_headers') {
                    try { setCustomHeaders(JSON.parse(item.value)) } catch (e) { setCustomHeaders([]) }
                } else if (item.key === 'discord_webhooks') {
                    try { setConfiguredWebhooks(JSON.parse(item.value)) } catch (e) { setConfiguredWebhooks([]) }
                } else if (item.key === 'search_acronyms') {
                    try { setCustomAcronyms(JSON.parse(item.value)); hasAcronyms = true; } catch (e) { setCustomAcronyms([]) }
                } else {
                    if (item.value) newConfig[item.key] = item.value 
                }
            });
        }

        // Initialize with default acronyms if none exist in the database yet
        if (!hasAcronyms) {
            setCustomAcronyms([
                { key: 'tmnt', value: 'teenage mutant ninja turtles' },
                { key: 'asm', value: 'amazing spider-man' },
                { key: 'f4', value: 'fantastic four' },
                { key: 'jla', value: 'justice league of america' },
                { key: 'jl', value: 'justice league' },
                { key: 'gotg', value: 'guardians of the galaxy' },
                { key: 'avx', value: 'avengers vs x-men' },
                { key: 'x-men', value: 'x men' }
            ]);
        }

        if (!newConfig.download_retry_delay) newConfig.download_retry_delay = "5";
        setConfig(newConfig);
    })
  }, [])

  const handleSave = async () => {
    setLoading(true);

    const payload = { 
        ...config,
        prowlarr_indexers_config: JSON.stringify(configuredIndexers), 
        custom_headers: JSON.stringify(customHeaders),
        search_acronyms: JSON.stringify(customAcronyms), 
        download_clients_config: JSON.stringify(configuredClients),
        discord_webhooks: JSON.stringify(configuredWebhooks)
    }
    
    setConfig(payload);

    try {
      const res = await fetch('/api/admin/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (res.ok) toast({ title: "Settings Saved", description: "Configuration persisted to database." })
    } finally { setLoading(false) }
  }

  const generateApiKey = () => {
      const array = new Uint8Array(24);
      window.crypto.getRandomValues(array);
      const key = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
      setConfig({ ...config, omnibus_api_key: key });
      toast({ title: "Key Generated", description: "Click 'Save All Changes' to apply the new API Key." });
  }

  const copyApiKey = () => {
      if (config.omnibus_api_key) {
          navigator.clipboard.writeText(config.omnibus_api_key);
          toast({ title: "Copied!", description: "API Key copied to clipboard." });
      }
  }

  const applyRecommendedFilters = () => {
      setConfig((prev: any) => ({
          ...prev,
          filter_enabled: "true",
          filter_publishers: RECOMMENDED_PUBLISHERS,
          filter_keywords: RECOMMENDED_KEYWORDS
      }));
      toast({ title: "Filters Applied", description: "Recommended blocklists loaded. Click 'Save All Changes' to apply." });
  }

  const refreshIndexers = async () => {
    setRefreshing(true); setHasRefreshed(true); setAvailableIndexers([]); 
    try {
        const res = await fetch('/api/admin/prowlarr/indexers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: config.prowlarr_url, apiKey: config.prowlarr_key, headers: customHeaders })
        });
        const data = await res.json();
        if (res.ok && Array.isArray(data)) setAvailableIndexers(data);
    } catch (e) { toast({ title: "Error", description: "Refresh failed.", variant: "destructive" }); } finally { setRefreshing(false); }
  }

  const openIndexerModal = (indexer: any, isEdit = false) => {
    const protocol = indexer.protocol || "torrent";
    if (isEdit) {
        setEditingIndexer({ ...indexer, seedRatio: indexer.seedRatio || 0 })
    } else {
        setEditingIndexer({
            id: indexer.id, name: indexer.name, priority: 25, seedTime: 0, seedRatio: 0, rss: true, protocol
        })
    }
    setIndexerModalOpen(true)
  }

  const saveIndexerConfig = () => {
    setConfiguredIndexers(prev => {
        const filtered = prev.filter(i => i.id !== editingIndexer.id);
        return [...filtered, editingIndexer];
    });
    setIndexerModalOpen(false);
    toast({ title: "Indexer Updated", description: "Don't forget to click Save All Changes." });
  }

  const deleteIndexer = (id: number) => {
    setConfiguredIndexers(prev => prev.filter(i => i.id !== id))
    toast({ title: "Indexer Removed" })
  }

  // --- Webhook Handlers ---
  const openWebhookModal = (webhook?: WebhookConfig) => {
    setTestResults(prev => ({ ...prev, webhooks: null }));
    if (webhook) {
      setEditingWebhook({ ...webhook })
    } else {
      setEditingWebhook({
        id: Math.random().toString(36).substr(2, 9),
        name: "", url: "", events: [], isActive: true
      })
    }
    setWebhookModalOpen(true)
  }

  const saveWebhook = () => {
    if (!editingWebhook?.name || !editingWebhook?.url) {
      toast({ title: "Validation Error", description: "Name and URL are required.", variant: "destructive" })
      return
    }
    setConfiguredWebhooks(prev => {
      const filtered = prev.filter(w => w.id !== editingWebhook.id);
      return [...filtered, editingWebhook];
    });
    setWebhookModalOpen(false);
    toast({ title: "Webhook Configured", description: "Remember to click 'Save All Changes' to apply." });
  }

  const deleteWebhook = (id: string) => {
    setConfiguredWebhooks(prev => prev.filter(w => w.id !== id))
    toast({ title: "Webhook Removed" })
  }

  const toggleWebhookActive = (id: string) => {
    setConfiguredWebhooks(prev => prev.map(w => w.id === id ? { ...w, isActive: !w.isActive } : w))
  }

  const toggleWebhookEvent = (eventId: string) => {
    if (!editingWebhook) return;
    const hasEvent = editingWebhook.events.includes(eventId);
    setEditingWebhook({
      ...editingWebhook,
      events: hasEvent 
        ? editingWebhook.events.filter(e => e !== eventId) 
        : [...editingWebhook.events, eventId]
    })
  }

  const handleTestWebhook = async (webhook: WebhookConfig) => {
    setTestingWebhookId(webhook.id);
    setTestResults(prev => ({ ...prev, webhooks: null }));

    try {
      const res = await fetch('/api/admin/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'webhook', config: webhook })
      });

      const data = await res.json();
      const result = { success: data.success, text: data.success ? data.message : (data.error || data.message || "Failed to reach Discord.") };
      
      setTestResults(prev => ({ ...prev, webhooks: result }));
      
      if (data.success) {
        toast({ title: "Test Sent", description: "Check your Discord channel." });
      } else {
        toast({ title: "Test Failed", description: result.text, variant: "destructive" });
      }
    } catch (e) {
      const errResult = { success: false, text: "System communication error." };
      setTestResults(prev => ({ ...prev, webhooks: errResult }));
      toast({ title: "Error", description: errResult.text, variant: "destructive" });
    } finally {
      setTestingWebhookId(null);
    }
  }

  const openClientSetup = (type: ClientConfig['type']) => {
    const protocols: Record<string, 'Torrent' | 'Usenet'> = { qbit: 'Torrent', deluge: 'Torrent', sab: 'Usenet', nzbget: 'Usenet' };
    const names: Record<string, string> = { qbit: 'qBittorrent', deluge: 'Deluge', sab: 'SABnzbd', nzbget: 'NZBGet' };
    setTestResults(prev => ({ ...prev, clients: null }));
    setEditingClient({
        id: Math.random().toString(36).substr(2, 9),
        type, name: names[type], protocol: protocols[type],
        url: "", user: "", pass: "", apiKey: "", category: "comics",
        remotePath: "", localPath: ""
    });
    setClientModalOpen(true);
  }

  const saveClientInState = () => {
    if (!editingClient) return;
    setConfiguredClients(prev => {
        const filtered = prev.filter(c => c.id !== editingClient.id);
        return [...filtered, editingClient];
    });
    setClientModalOpen(false);
    toast({ title: "Client Added", description: "Remember to click 'Save All Changes' above." });
  };

  const deleteClient = (id: string) => {
    setConfiguredClients(prev => prev.filter(c => c.id !== id));
    toast({ title: "Client Removed" });
  }

  const handleTest = async (type: string, overrideConfig?: any) => {
    setTesting(type); 
    setTestResults(prev => ({ ...prev, [type]: null }));
    
    try {
      const liveHeaders = JSON.stringify(customHeaders);
      const testConfig = { ...config, ...(overrideConfig || {}), custom_headers: liveHeaders };

      const res = await fetch('/api/admin/test', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ type, config: testConfig }) 
      });
      
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [type]: { success: data.success, text: data.message || data.error || "Failed." } }));
    } catch (e) {
      setTestResults(prev => ({ ...prev, [type]: { success: false, text: "Communication Error" } }));
    } finally { 
      setTesting(null); 
    }
  }

  const addHeader = (k = "") => setCustomHeaders([...customHeaders, { key: k, value: "" }])
  const updateHeader = (i: number, f: 'key' | 'value', v: string) => { const h = [...customHeaders]; h[i][f] = v; setCustomHeaders(h); }
  const removeHeader = (i: number) => setCustomHeaders(customHeaders.filter((_, idx) => idx !== i))

  const StatusBox = ({ result }: { result: { success: boolean, text: string } | null }) => {
    if (!result) return null;
    const isFailure = !result.success || result.text.includes('❌') || result.text.includes('Error') || result.text.includes('Not Found') || result.text.toLowerCase().includes('failed');

    return (
        <div className={`mt-4 p-4 rounded-md border flex items-center gap-3 transition-colors duration-300 ${!isFailure ? "border-green-200 bg-green-50/30 text-green-800 dark:border-green-900/50 dark:bg-green-900/10 dark:text-green-400" : "border-red-200 bg-red-50/30 text-red-800 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-400"}`}>
            {!isFailure ? <CheckCircle className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}
            <span className="text-sm font-medium">{result.text}</span>
        </div>
    );
  };

  return (
    <div className="container mx-auto py-6 sm:py-10 px-4 sm:px-6 max-w-5xl space-y-6 sm:space-y-8 transition-colors duration-300">
        <title>Omnibus - Settings</title>
      <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-3 sm:gap-4">
            <Link href="/admin"><Button variant="ghost" size="icon" className="h-10 w-10 sm:h-9 sm:w-9 hover:bg-muted text-foreground"><ArrowLeft className="w-5 h-5" /></Button></Link>
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">System Settings</h1>
        </div>
        <Button onClick={handleSave} disabled={loading} size="lg" className="w-full sm:w-auto h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground"><Save className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />Save All Changes</Button>
      </div>

      <Tabs defaultValue="comicvine" className="w-full space-y-6">
        
        <TabsList className="flex w-full overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] h-auto bg-muted border border-border gap-1 p-1 justify-start lg:justify-center">
          <TabsTrigger value="comicvine" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">ComicVine</TabsTrigger>
          <TabsTrigger value="indexers" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Indexers</TabsTrigger>
          <TabsTrigger value="clients" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Clients</TabsTrigger>
          <TabsTrigger value="paths" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Paths</TabsTrigger>
          <TabsTrigger value="network" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Network</TabsTrigger>
          <TabsTrigger value="filters" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Filters</TabsTrigger>
          <TabsTrigger value="alerts" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Alerts</TabsTrigger>
          <TabsTrigger value="api" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">API</TabsTrigger>
          <TabsTrigger value="sso" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">SSO</TabsTrigger>
        </TabsList>

        {/* 1. COMICVINE */}
        <TabsContent value="comicvine">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Key className="w-5 h-5 text-primary" /> ComicVine Integration</CardTitle>
                    <CardDescription className="text-muted-foreground">ComicVine is the primary source of metadata for Omnibus. It provides high-resolution covers, series descriptions, and release dates.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">ComicVine API Key</Label>
                        <Input type="password" value={config.cv_api_key || ""} onChange={(e) => setConfig({...config, cv_api_key: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                    </div>
                    <p className="text-[0.8rem] text-muted-foreground">Get your free API Key from <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noreferrer" className="underline text-primary hover:text-primary/80 transition-colors">ComicVine.com/api</a>.</p>
                    <div className="border-t border-border my-4" />
                    <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('comicvine')} disabled={!!testing}>
                        {testing === 'comicvine' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test Connection
                    </Button>
                    <StatusBox result={testResults.comicvine} />
                </CardContent>
            </Card>
        </TabsContent>

        {/* 2. INDEXERS */}
        <TabsContent value="indexers">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Cloud className="w-5 h-5 text-primary" /> Indexer Configuration</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure your Prowlarr connection and manage which indexers to use with priority and seeding time.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid gap-2"><Label className="text-foreground font-semibold">Prowlarr URL</Label><Input value={config.prowlarr_url} onChange={(e) => setConfig({...config, prowlarr_url: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" /></div>
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">API Key</Label>
                        <Input type="password" value={config.prowlarr_key} onChange={(e) => setConfig({...config, prowlarr_key: e.target.value})} className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                        <p className="text-[0.8rem] text-muted-foreground">Found in Prowlarr Settings → General → Security → API Key</p>
                    </div>
                    <div className="border-t border-border my-4" />
                    <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('prowlarr')} disabled={!!testing}>Test Connection</Button>
                    <StatusBox result={testResults.prowlarr} />
                    <div className="border-t border-border my-4" />
                    
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
                </CardContent>
            </Card>
        </TabsContent>

        {/* 3. DOWNLOAD CLIENTS */}
        <TabsContent value="clients">
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
                                            <Badge className="bg-green-600 text-white border-0 py-1.5 w-full flex justify-center"><CheckCircle className="w-4 h-4 sm:w-3 sm:h-3 mr-1.5"/> Configured</Badge>
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
                                                    <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:bg-muted text-foreground" onClick={() => {setEditingClient(client); setClientModalOpen(true)}}><Settings className="h-5 w-5 sm:h-4 sm:w-4"/></Button>
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
        </TabsContent>

        {/* 4. PATHS & AUTO-ROUTING */}
        <TabsContent value="paths" className="space-y-6">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground">
                        <HardDrive className="w-5 h-5 text-primary" /> Library Directories & Routing
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">Configure where Omnibus reads and writes files across your system.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                    
                    {/* STANDARD AND MANGA LIBRARIES */}
                    <div className="grid gap-6 md:grid-cols-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <div className="space-y-2">
                            <Label className="text-base sm:text-lg font-bold text-foreground">Standard Library Destination</Label>
                            <Input 
                                value={config.library_path} 
                                onChange={e => setConfig({...config, library_path: e.target.value})} 
                                placeholder={typeof window !== 'undefined' && navigator.platform.indexOf('Win') > -1 ? "C:\\Comics\\Library" : "/library"} 
                                className="h-12 sm:h-10 font-mono bg-background border-border text-foreground"
                            />
                            <p className="text-[11px] text-muted-foreground">The primary home for your standard Western comics.</p>
                        </div>
                        <div className="space-y-2">
                            <Label className="text-base sm:text-lg font-bold text-primary">Manga Library Destination <span className="text-xs font-normal text-muted-foreground ml-1">(Optional)</span></Label>
                            <Input 
                                value={config.manga_library_path || ""} 
                                onChange={e => setConfig({...config, manga_library_path: e.target.value})} 
                                placeholder={typeof window !== 'undefined' && navigator.platform.indexOf('Win') > -1 ? "C:\\Comics\\Manga" : "/manga"} 
                                className="h-12 sm:h-10 font-mono bg-background border-border text-foreground"
                            />
                            <p className="text-[11px] text-muted-foreground">Manga series automatically detected by the engine will be routed here instead of the Standard Library.</p>
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Download Scan Root</Label>
                        <Input 
                            value={config.download_path} 
                            onChange={e => setConfig({...config, download_path: e.target.value})} 
                            placeholder={typeof window !== 'undefined' && navigator.platform.indexOf('Win') > -1 ? "C:\\Downloads\\Comics" : "/downloads"} 
                            className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                        />
                        <p className="text-[11px] text-muted-foreground">The folder Omnibus scans for finished downloads before importing them.</p>
                    </div>

                    <div className="border-t border-border my-4" />
                    <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('paths')} disabled={!!testing}>
                        {testing === 'paths' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test File Permissions
                    </Button>
                    <StatusBox result={testResults.paths} />
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
                        className="w-full h-12 sm:h-10 font-bold border-primary text-primary hover:bg-primary/10 transition-colors" 
                        variant="outline" 
                        onClick={() => handleTest('mapping', { remote: config.remote_path_mapping, local: config.local_path_mapping })} 
                        disabled={!!testing}
                    >
                        {testing === 'mapping' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2"/> : <RefreshCw className="w-5 h-5 sm:w-4 sm:h-4 mr-2"/>} 
                        Test Logic
                    </Button>
                    <StatusBox result={testResults.mapping} />
                </CardContent>
            </Card>
        </TabsContent>

        {/* 5. NETWORK */}
        <TabsContent value="network">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Shield className="w-5 h-5 text-primary" /> Network & Security</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure custom HTTP headers for all outgoing requests and manage connection timeouts/retries.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
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

                    <div className="border-t border-border" />
                    
                    <div className="space-y-4">
                        <Label className="text-base font-bold text-foreground">Custom Request Headers</Label>
                        <div className="flex flex-col sm:flex-row gap-2 mb-2">
                            <Select onValueChange={addHeader}>
                                <SelectTrigger className="h-12 sm:h-10 w-full sm:w-[250px] bg-background border-border text-foreground"><SelectValue placeholder="Add Common Header..." /></SelectTrigger>
                                <SelectContent className="bg-popover border-border">
                                    <SelectItem value="CF-Access-Client-Id" className="focus:bg-primary/10 focus:text-primary">Cloudflare Client ID</SelectItem>
                                    <SelectItem value="CF-Access-Client-Secret" className="focus:bg-primary/10 focus:text-primary">Cloudflare Secret</SelectItem>
                                    <SelectItem value="Authorization" className="focus:bg-primary/10 focus:text-primary">Authorization Token</SelectItem>
                                </SelectContent>
                            </Select>
                            <Button variant="outline" onClick={() => addHeader("")} className="h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground"><Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-1 text-primary"/> Add Custom</Button>
                        </div>
                        <div className="space-y-3">
                            {customHeaders.map((h, i) => (
                                <div key={i} className="flex flex-col sm:flex-row gap-2 animate-in fade-in slide-in-from-top-1 bg-muted/50 p-2 rounded-md sm:bg-transparent sm:p-0 sm:rounded-none sm:border-0 border border-border">
                                    <Input placeholder="Header Name" value={h.key} onChange={e => updateHeader(i, 'key', e.target.value)} className="h-12 sm:h-10 bg-background border-border text-foreground" />
                                    <div className="flex gap-2 w-full">
                                      <Input type="password" placeholder="Header Value" value={h.value} onChange={e => updateHeader(i, 'value', e.target.value)} className="h-12 sm:h-10 flex-1 bg-background border-border text-foreground" />
                                      <Button variant="ghost" size="icon" onClick={() => removeHeader(i)} className="h-12 w-12 sm:h-10 sm:w-10 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200"><Trash2 className="h-5 w-5 sm:h-4 sm:w-4"/></Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </TabsContent>

        {/* 6. DISCOVER & FILTERING */}
        <TabsContent value="filters">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Filter className="w-5 h-5 text-primary" /> Discover & Filtering</CardTitle>
                    <CardDescription className="text-muted-foreground">Filter out unwanted series or publishers from the Discover grids (New Releases, Popular).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Switch 
                            id="filter-toggle"
                            checked={config.filter_enabled === "true"} 
                            onCheckedChange={(c) => setConfig({...config, filter_enabled: c ? "true" : "false"})} 
                            className="scale-110 sm:scale-100"
                        />
                        <Label htmlFor="filter-toggle" className="cursor-pointer font-bold text-base text-foreground">Enable Content Filtering</Label>
                    </div>
                    
                    <div className="space-y-4">
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
                    </div>

                    <div className="border-t border-border my-4" />
                    <div className="bg-primary/5 p-4 rounded-lg border border-primary/20 flex flex-col sm:flex-row justify-between items-center gap-4">
                        <div className="text-sm text-foreground/80">
                            <strong className="text-primary">Quick Setup:</strong> Load a pre-configured blocklist of common adult publishers and keywords.
                        </div>
                        <Button variant="secondary" onClick={applyRecommendedFilters} className="h-12 sm:h-10 w-full sm:w-auto font-bold shrink-0 bg-background border-border shadow-sm text-foreground hover:bg-muted">
                            Load NSFW Defaults
                        </Button>
                    </div>

                    {/* Acronym Customization */}
                    <div className="space-y-4 pt-6 border-t border-border">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                            <div>
                                <Label className="text-base font-bold text-foreground">Search Acronym Expansion</Label>
                                <p className="text-[11px] text-muted-foreground mt-1">Automatically expand acronyms during automated fuzzy searches (e.g., "TMNT" &rarr; "Teenage Mutant Ninja Turtles").</p>
                            </div>
                            <Button variant="outline" size="sm" onClick={() => setCustomAcronyms([...customAcronyms, { key: "", value: "" }])} className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground">
                                <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-1 text-primary"/> Add Acronym
                            </Button>
                        </div>
                        
                        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                            {customAcronyms.length === 0 && <p className="text-sm text-muted-foreground italic bg-muted/20 p-4 rounded-md border border-border">No custom acronyms defined. System defaults will be used.</p>}
                            {customAcronyms.map((ac, i) => (
                                <div key={i} className="flex flex-col sm:flex-row gap-2 animate-in fade-in slide-in-from-top-1 bg-muted/30 p-2 rounded-md sm:bg-transparent sm:p-0 sm:rounded-none sm:border-0 border border-border">
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
                                      <Button variant="ghost" size="icon" onClick={() => setCustomAcronyms(customAcronyms.filter((_, idx) => idx !== i))} className="h-12 w-12 sm:h-10 sm:w-10 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200">
                                          <Trash2 className="h-5 w-5 sm:h-4 sm:w-4"/>
                                      </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>
        </TabsContent>

        {/* 7. ALERTS (DISCORD WEBHOOKS) */}
        <TabsContent value="alerts">
          <Card className="shadow-sm border-border bg-background">
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-foreground">
                    <Bell className="w-5 h-5 text-primary" /> Discord Notifications
                  </CardTitle>
                  <CardDescription className="text-muted-foreground">
                    Configure automated server alerts to keep your team updated on requests and system events.
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => openWebhookModal()} className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground transition-colors">
                  <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary" /> Add Webhook
                </Button>
              </div>
            </CardHeader>
            
            <CardContent className="space-y-6">
              {configuredWebhooks.length === 0 ? (
                <div className="border-2 border-dashed border-border rounded-lg p-10 text-center text-muted-foreground">
                  No webhooks configured yet. Add one to start receiving Discord alerts.
                </div>
              ) : (
                <div className="grid gap-4">
                  {configuredWebhooks.map(hook => (
                    <div key={hook.id} className="flex flex-col border border-border rounded-lg bg-muted/20 shadow-sm p-4 gap-3">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex flex-col gap-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-lg sm:text-base text-foreground">{hook.name}</span>
                            <Badge variant={hook.isActive ? "secondary" : "outline"} className={hook.isActive ? "bg-primary/10 text-primary border-primary/20" : "text-muted-foreground border-border"}>
                              {hook.isActive ? "Active" : "Disabled"}
                            </Badge>
                          </div>
                          <p className="text-xs sm:text-[11px] font-mono text-muted-foreground truncate max-w-[300px] sm:max-w-md">
                            {hook.url.replace(/https:\/\/discord\.com\/api\/webhooks\/[^\/]+\//, "https://.../")}
                          </p>
                        </div>
                        
                        <div className="flex items-center gap-2 shrink-0 border-t sm:border-0 border-border pt-3 sm:pt-0">
                          <Button 
                            variant="outline" 
                            size="icon" 
                            className="h-10 w-10 sm:h-8 sm:w-8 text-primary hover:bg-primary/10 border-primary/20 transition-colors" 
                            disabled={testingWebhookId === hook.id}
                            onClick={() => handleTestWebhook(hook)}
                          >
                            {testingWebhookId === hook.id ? <Loader2 className="h-5 w-5 sm:h-4 sm:w-4 animate-spin" /> : <Send className="h-5 w-5 sm:h-4 sm:w-4" />}
                          </Button>
                          <Switch checked={hook.isActive} onCheckedChange={() => toggleWebhookActive(hook.id)} className="mx-2 scale-110 sm:scale-100" />
                          <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:bg-muted text-foreground" onClick={() => openWebhookModal(hook)}>
                            <Settings className="h-5 w-5 sm:h-4 sm:w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => deleteWebhook(hook.id)}>
                            <Trash2 className="h-5 w-5 sm:h-4 sm:w-4" />
                          </Button>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap gap-1.5 bg-background p-2 rounded-md border border-border shadow-inner">
                        {hook.events.map(ev => (
                          <Badge key={ev} variant="outline" className="text-[10px] uppercase tracking-tighter border-border text-muted-foreground">
                            {ev.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>

                      {testingWebhookId === hook.id && testResults.webhooks && (
                        <StatusBox result={testResults.webhooks} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-border my-4" />
              <div className="bg-primary/5 p-4 rounded-lg border border-primary/20 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <p className="text-xs text-foreground/80">
                  <strong className="text-primary">Pro-Tip:</strong> Separate webhooks allow for channel-specific logging. For example, send "Download Failed" to your #dev-logs and "Comic Available" to #general.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* SSO / AUTH */}
        <TabsContent value="sso">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Fingerprint className="w-5 h-5 text-primary" /> Single Sign-On (SSO)</CardTitle>
                    <CardDescription className="text-muted-foreground">Integrate Omnibus with an OpenID Connect (OIDC) identity provider like Authelia, Authentik, or Keycloak.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Switch 
                            id="oidc-toggle"
                            checked={config.oidc_enabled === "true"} 
                            onCheckedChange={(c) => setConfig({...config, oidc_enabled: c ? "true" : "false"})} 
                            className="scale-110 sm:scale-100"
                        />
                        <Label htmlFor="oidc-toggle" className="cursor-pointer font-bold text-base text-foreground">Enable OIDC Authentication</Label>
                    </div>

                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label className="text-foreground font-semibold">Issuer URL</Label>
                            <Input 
                                placeholder="https://auth.yourdomain.com" 
                                value={config.oidc_issuer || ""} 
                                onChange={e => setConfig({...config, oidc_issuer: e.target.value})} 
                                className="h-12 sm:h-10 bg-muted/20 border-border text-foreground"
                            />
                            <p className="text-[11px] text-muted-foreground">The base URL of your identity provider.</p>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label className="text-foreground font-semibold">Client ID</Label>
                                <Input 
                                    value={config.oidc_client_id || ""} 
                                    onChange={e => setConfig({...config, oidc_client_id: e.target.value})} 
                                    className="h-12 sm:h-10 bg-muted/20 border-border text-foreground"
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-foreground font-semibold">Client Secret</Label>
                                <Input 
                                    type="password"
                                    value={config.oidc_client_secret || ""} 
                                    onChange={e => setConfig({...config, oidc_client_secret: e.target.value})} 
                                    className="h-12 sm:h-10 bg-muted/20 border-border text-foreground"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="border-t border-border pt-4">
                        <Label className="text-sm font-bold text-primary mb-2 block">Redirect URI Setup</Label>
                        <p className="text-[12px] text-muted-foreground mb-2">You must add this exact Redirect URI to your OIDC provider's client configuration:</p>
                        <div className="flex items-center gap-2">
                            <Input 
                                readOnly
                                value={typeof window !== 'undefined' ? `${window.location.origin}/api/auth/callback/oidc` : ''} 
                                className="h-12 sm:h-10 font-mono text-xs text-muted-foreground bg-muted/30 border-dashed border-border"
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>
        </TabsContent>

        {/* 8. API KEYS */}
        <TabsContent value="api">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Webhook className="w-5 h-5 text-primary" /> External API Integrations</CardTitle>
                    <CardDescription className="text-muted-foreground">Generate an API key to allow external applications (like Discord Bots or Dashboards) to fetch stats and interact with Omnibus securely.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Omnibus API Key</Label>
                        <div className="flex gap-2">
                            <Input 
                                type="text" 
                                readOnly
                                value={config.omnibus_api_key || ""} 
                                placeholder="No key generated. Click 'Generate New Key' below." 
                                className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-muted-foreground" 
                            />
                            <Button variant="outline" size="icon" className="h-12 w-12 sm:h-10 sm:w-10 shrink-0 border-border hover:bg-muted text-foreground transition-colors" onClick={copyApiKey} disabled={!config.omnibus_api_key}>
                                <Copy className="w-5 h-5 sm:w-4 sm:h-4 text-primary" />
                            </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            Pass this key in the header of your external requests as <code className="bg-muted px-1 rounded border border-border">X-Api-Key</code>.
                        </p>
                    </div>
                    
                    <div className="border-t border-border my-4" />
                    
                    <Button variant="secondary" onClick={generateApiKey} className="h-12 sm:h-10 font-bold w-full sm:w-auto bg-muted hover:bg-muted/80 text-foreground transition-all">
                        <RefreshCw className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary" /> Generate New Key
                    </Button>
                </CardContent>
            </Card>
        </TabsContent>

      </Tabs>

      {/* --- MODALS --- */}
      
      {/* WEBHOOK MODAL */}
      <Dialog open={webhookModalOpen} onOpenChange={setWebhookModalOpen}>
        <DialogContent className="sm:max-w-md w-[95%] bg-background border-border rounded-xl shadow-2xl transition-colors duration-300">
          <DialogHeader>
            <DialogTitle className="text-foreground">{editingWebhook?.name ? "Edit Webhook" : "New Webhook"}</DialogTitle>
            <DialogDescription className="text-muted-foreground">Configure your Discord integration details and events.</DialogDescription>
          </DialogHeader>
          
          {editingWebhook && (
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Webhook Name</Label>
                <Input 
                  placeholder="e.g. Admin Alerts" 
                  value={editingWebhook.name} 
                  onChange={e => setEditingWebhook({ ...editingWebhook, name: e.target.value })}
                  className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" 
                />
              </div>
              
              <div className="grid gap-2">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Webhook URL</Label>
                <div className="flex gap-2">
                  <Input 
                    placeholder="https://discord.com/api/webhooks/..." 
                    value={editingWebhook.url} 
                    onChange={e => setEditingWebhook({ ...editingWebhook, url: e.target.value })}
                    className="h-12 sm:h-10 font-mono text-xs bg-muted/20 border-border flex-1 text-foreground" 
                  />
                  <Button 
                    variant="secondary" 
                    className="h-12 sm:h-10 font-bold bg-muted hover:bg-muted/80 text-foreground"
                    disabled={!editingWebhook.url || testingWebhookId === editingWebhook.id}
                    onClick={() => handleTestWebhook(editingWebhook)}
                  >
                    {testingWebhookId === editingWebhook.id ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : "Test"}
                  </Button>
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-border">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                <div className="grid gap-2 max-h-[250px] overflow-y-auto pr-2">
                  {DISCORD_EVENTS.map(event => (
                    <div key={event.id} className="flex items-start space-x-3 p-2 sm:p-2 rounded hover:bg-muted/50 border border-transparent hover:border-border transition-colors group">
                      <Checkbox 
                        id={event.id} 
                        checked={editingWebhook.events.includes(event.id)}
                        onCheckedChange={() => toggleWebhookEvent(event.id)}
                        className="mt-1 sm:mt-0 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                      />
                      <div className="grid gap-1.5 leading-none">
                        <label htmlFor={event.id} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">
                          {event.label}
                        </label>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                          {event.desc}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <StatusBox result={testResults.webhooks} />
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
             <Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setWebhookModalOpen(false)}>Cancel</Button>
             <Button onClick={saveWebhook} className="h-12 sm:h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-md">
                Save Integration
             </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CLIENT MODAL */}
      <Dialog open={clientModalOpen} onOpenChange={setClientModalOpen}>
        <DialogContent className="sm:max-w-[500px] w-[95%] bg-background border-border rounded-xl max-h-[90vh] overflow-y-auto shadow-2xl transition-colors duration-300">
            <DialogHeader><DialogTitle className="text-foreground">Configure {editingClient?.name}</DialogTitle></DialogHeader>
            {editingClient && (
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Server URL</Label>
                        <Input value={editingClient.url} onChange={e => setEditingClient({...editingClient, url: e.target.value})} placeholder="http://192.168.1.100:8080" className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                    </div>

                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Download Category / Label</Label>
                        <Input value={editingClient.category || ""} onChange={e => setEditingClient({...editingClient, category: e.target.value})} placeholder="e.g. comics" className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                        <p className="text-[11px] text-muted-foreground">Sets the category in the client for automatic folder sorting.</p>
                    </div>

                    <div className="border-t border-border pt-4 mt-2">
                        <div className="flex items-center gap-2 mb-3">
                            <FolderOpen className="w-4 h-4 text-primary" />
                            <Label className="font-bold text-xs uppercase text-muted-foreground">Docker Path Mapping</Label>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label className="text-[11px] text-muted-foreground">Remote Path (Client)</Label>
                                <Input className="h-12 sm:h-10 text-xs font-mono bg-background border-border text-foreground" value={editingClient.remotePath || ""} onChange={e => setEditingClient({...editingClient, remotePath: e.target.value})} placeholder="/downloads/comics" />
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-[11px] text-muted-foreground">Local Path (Omnibus)</Label>
                                <Input className="h-12 sm:h-10 text-xs font-mono bg-background border-border text-foreground" value={editingClient.localPath || ""} onChange={e => setEditingClient({...editingClient, localPath: e.target.value})} placeholder="/data/downloads" />
                            </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-2">
                            Use this if Omnibus and the Download Client see different paths (e.g. Docker volumes).
                        </p>
                    </div>

                    {['qbit', 'deluge', 'nzbget'].includes(editingClient.type) && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2 border-t border-border pt-4">
                            <div className="grid gap-2"><Label className="text-foreground font-semibold">User</Label><Input value={editingClient.user} onChange={e => setEditingClient({...editingClient, user: e.target.value})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" /></div>
                            <div className="grid gap-2"><Label className="text-foreground font-semibold">Pass</Label><Input type="password" value={editingClient.pass} onChange={e => setEditingClient({...editingClient, pass: e.target.value})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" /></div>
                        </div>
                    )}
                    {['sab'].includes(editingClient.type) && (
                        <div className="grid gap-2 mt-2 border-t border-border pt-4"><Label className="text-foreground font-semibold">API Key</Label><Input value={editingClient.apiKey || ""} onChange={e => setEditingClient({...editingClient, apiKey: e.target.value})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" /></div>
                    )}
                    <div className="border-t border-border pt-4">
                        <Button variant="outline" className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" onClick={() => handleTest('clients', { clientType: editingClient.type, ...editingClient })} disabled={!!testing}>
                            {testing ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test Connection
                        </Button>
                        <StatusBox result={testResults.clients} />
                    </div>
                </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0"><Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setClientModalOpen(false)}>Cancel</Button><Button className="h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md" onClick={saveClientInState}>Save Settings</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* INDEXER MODAL */}
      <Dialog open={indexerModalOpen} onOpenChange={setIndexerModalOpen}>
        <DialogContent className="sm:max-w-md w-[95%] bg-background border-border rounded-xl shadow-2xl transition-colors duration-300">
            <DialogHeader><DialogTitle className="text-foreground">Configure {editingIndexer.name}</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label className="text-foreground font-semibold">Priority (1-25)</Label>
                    <Input type="number" value={editingIndexer.priority} onChange={e => setEditingIndexer({...editingIndexer, priority: parseInt(e.target.value)})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Seed Time (minutes)</Label>
                        <Input type="number" value={editingIndexer.seedTime} onChange={e => setEditingIndexer({...editingIndexer, seedTime: parseInt(e.target.value)})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                        <p className="text-[10px] text-muted-foreground italic">0 = Client default.</p>
                    </div>
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Seed Ratio</Label>
                        <Input type="number" step="0.1" value={editingIndexer.seedRatio} onChange={e => setEditingIndexer({...editingIndexer, seedRatio: parseFloat(e.target.value)})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                        <p className="text-[10px] text-muted-foreground italic">e.g. 1.5. (0 = Client default).</p>
                    </div>
                </div>

                <div className="flex items-center gap-2 pt-2 bg-muted/30 p-4 rounded-lg border border-border group cursor-pointer" onClick={() => setEditingIndexer({...editingIndexer, rss: !editingIndexer.rss})}>
                    <Checkbox id="rss" checked={editingIndexer.rss} onCheckedChange={c => setEditingIndexer({...editingIndexer, rss: !!c})} className="border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary scale-110 sm:scale-100" />
                    <Label htmlFor="rss" className="cursor-pointer font-bold ml-2 text-foreground group-hover:text-primary transition-colors">Enable RSS Monitoring</Label>
                </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0"><Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setIndexerModalOpen(false)}>Cancel</Button><Button className="h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md" onClick={saveIndexerConfig}>Save Settings</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}