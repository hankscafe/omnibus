// src/app/admin/settings/page.tsx
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  FolderOpen, HardDrive, Save, Cloud, CheckCircle, Loader2, Key, ArrowLeft, 
  XCircle, RefreshCw, Plus, Settings, Shield, Trash2, Zap, Download, Filter, Webhook, Copy, Bell, AlertCircle, Send, Fingerprint, CheckCircle2, X, Database, FileText, Mail, FileEdit, Server, ArrowUp, ArrowDown,
  Folder,
  Clock,
  Smartphone,
  Globe,
  AlertTriangle,
  RotateCcw // <-- Added Icon Here
} from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

// --- Types ---
interface LibraryConfig { id: string; name: string; path: string; isManga: boolean; isDefault: boolean; }
interface IndexerConfig { id: number; name: string; priority: number; seedTime: number; seedRatio: number; rss: boolean; protocol: string; }
interface CustomHeader { id?: string; key: string; value: string; }
interface AcronymConfig { id?: string; key: string; value: string; }
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
    botUsername?: string;
    botAvatarUrl?: string;
}
interface HosterAccountConfig {
    id: string;
    name: string;
    hoster: string;
    username?: string;
    password?: string;
    apiKey?: string;
    isActive: boolean;
}

// --- Constants & Global Mappings ---
const RECOMMENDED_PUBLISHERS = "hakusensha, shueisha, kodansha, shogakukan, square enix, yen press, viz media, seven seas, fakku, project-h, denpa, irodori, eros comix, tokyopop, kadokawa, futabasha, houbunsha, takeshobo, mag garden, akita shoten, shonen gahosha, nihon bungeisha, coamix, gee-whiz, ghost ship, j-novel club, suiseisha, shinchosha, ascii media works, ichijinsha";
const RECOMMENDED_KEYWORDS = "weekly young, young animal, weekly shonen, monthly shonen, gee-whiz, manga, hentai, doujinshi, shoujo, seinen, shojo, josei, gaze, lustiges taschenbuch enten-edition, les tuniques bleues, big comic superior, Creature Girls: A Hands-On Field Journal In Another World, Young King Bull, weekly playboy, big comic spirits, Young Champion Retsu, Big Comic Zōkan, Monthly Young Magazine, Comic Zenon, shonen sunday s, Chira Chiller, young champion, young king, yojng comic, Shana-Ou Yoshitsune";

const hosterDisplayNames: Record<string, string> = {
    'mediafire': 'MediaFire',
    'getcomics': 'GetComics (Direct)',
    'mega': 'Mega',
    'pixeldrain': 'Pixeldrain',
    'rootz': 'Rootz',
    'vikingfile': 'VikingFile',
    'terabox': 'Terabox',
    'annas_archive': "Anna's Archive"
};

const SYSTEM_EVENTS = [
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
  { id: "job_diagnostics", label: "System Diagnostics Complete", desc: "Notifies when automated system diagnostics have been run." },
  { id: "job_cache_cleanup", label: "Cache Cleanup Complete", desc: "Notifies when the automated cache cleanup finishes." }
];

export default function SettingsPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  
  // Start on the consolidated Metadata tab
  const [activeTab, setActiveTab] = useState("metadata")
  
  const [testResults, setTestResults] = useState<{ [key: string]: { success: boolean, text: string } | null }>({
    comicvine: null, metron: null, prowlarr: null, clients: null, paths: null, mapping: null, webhooks: null, smtp: null, smtp_digest: null, flaresolverr: null,
    pushover: null, telegram: null, apprise: null
  })
  
  const [refreshing, setRefreshing] = useState(false)
  const [availableIndexers, setAvailableIndexers] = useState<any[]>([])
  const [hasRefreshed, setHasRefreshed] = useState(false)

  // DB Array States
  const [configuredLibraries, setConfiguredLibraries] = useState<LibraryConfig[]>([])
  const [configuredIndexers, setConfiguredIndexers] = useState<IndexerConfig[]>([])
  const [configuredClients, setConfiguredClients] = useState<ClientConfig[]>([])
  const [configuredWebhooks, setConfiguredWebhooks] = useState<WebhookConfig[]>([])
  const [customHeaders, setCustomHeaders] = useState<CustomHeader[]>([])
  const [customAcronyms, setCustomAcronyms] = useState<AcronymConfig[]>([]) 
  const [envPaths, setEnvPaths] = useState<any>({})
  
  // Hoster States
  const [configuredHosters, setConfiguredHosters] = useState<HosterAccountConfig[]>([])
  const [hosterPriority, setHosterPriority] = useState<{hoster: string, enabled: boolean}[]>([
      { hoster: 'mediafire', enabled: true },
      { hoster: 'getcomics', enabled: true },
      { hoster: 'mega', enabled: true },
      { hoster: 'pixeldrain', enabled: true },
      { hoster: 'rootz', enabled: true },
      { hoster: 'vikingfile', enabled: true },
      { hoster: 'terabox', enabled: true },
      { hoster: 'annas_archive', enabled: true }
  ])
  const [hosterModalOpen, setHosterModalOpen] = useState(false)
  const [editingHoster, setEditingHoster] = useState<HosterAccountConfig | null>(null)

  // API Keys / Users States
  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [newKeyName, setNewKeyName] = useState("")
  const [newKeyUserId, setNewKeyUserId] = useState("")
  const [newKeyExpiration, setNewKeyExpiration] = useState("0")
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [isGeneratingKey, setIsGeneratingKey] = useState(false)

  const [indexerModalOpen, setIndexerModalOpen] = useState(false)
  const [editingIndexer, setEditingIndexer] = useState<IndexerConfig>({ 
    id: 0, name: "", priority: 1, seedTime: 0, seedRatio: 0, rss: false, protocol: "torrent" 
  })

  const [clientModalOpen, setClientModalOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<any>(null)

  const [webhookModalOpen, setWebhookModalOpen] = useState(false)
  const [editingWebhook, setEditingWebhook] = useState<WebhookConfig | null>(null)

  const { toast } = useToast()
  
  const [config, setConfig] = useState<any>({
    prowlarr_url: "", prowlarr_key: "", prowlarr_categories: "7030, 8030", download_path: "", cv_api_key: "",
    metron_user: "", metron_pass: "",
    export_series_json: "false", 
    remote_path_mapping: "", local_path_mapping: "", flaresolverr_url: "",
    filter_enabled: "false", filter_publishers: "", filter_keywords: "",
    filter_foreign_publishers: "",
    show_popular_issues: "true", show_new_releases: "true", 
    manga_publishers: "", western_publishers: "",
    discover_manga_filter_mode: "SHOW_ALL", discover_manga_allowed_publishers: "",
    download_retry_delay: "5",
    convert_to_webp: "false", webp_quality: "80", 
    oidc_enabled: "false", oidc_issuer: "", oidc_client_id: "", oidc_client_secret: "",
    oidc_force_sso: "false", oidc_auto_approve: "false", oidc_admin_group: "", oidc_user_group: "",
    folder_naming_pattern: "", file_naming_pattern: "", manga_file_naming_pattern: "",
    smtp_enabled: "false", smtp_host: "", smtp_port: "", smtp_user: "", smtp_pass: "", smtp_from: "",
    discord_enabled: "true",
    pushover_enabled: "false", pushover_token: "", pushover_user: "", pushover_events: "[]",
    telegram_enabled: "false", telegram_bot_token: "", telegram_chat_id: "", telegram_events: "[]",
    apprise_enabled: "false", apprise_url: "", apprise_events: "[]"
  })

  // --- UNSAVED CHANGES STATES ---
  const [isDataLoaded, setIsDataLoaded] = useState(false)
  const [initialStateHash, setInitialStateHash] = useState("")
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null)

  const currentStateString = JSON.stringify({
      config, configuredLibraries, configuredIndexers, configuredClients,
      configuredHosters, configuredWebhooks, customHeaders, customAcronyms, hosterPriority
  });

  const hasUnsavedChanges = isDataLoaded && initialStateHash !== "" && currentStateString !== initialStateHash;

  useEffect(() => {
      if (isDataLoaded && initialStateHash === "") {
          setInitialStateHash(currentStateString);
      }
  }, [isDataLoaded, currentStateString, initialStateHash]);

  useEffect(() => {
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
          if (hasUnsavedChanges) {
              e.preventDefault();
              e.returnValue = '';
          }
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
      const handleClick = (e: MouseEvent) => {
          if (!hasUnsavedChanges) return;
          const target = e.target as HTMLElement;
          const anchor = target.closest('a');
          if (anchor && anchor.href) {
              const url = new URL(anchor.href);
              if (url.origin === window.location.origin && url.pathname !== window.location.pathname) {
                  if (anchor.hasAttribute('download') || anchor.target === '_blank') return;
                  e.preventDefault();
                  e.stopPropagation();
                  setPendingNavigation(url.pathname + url.search);
                  setUnsavedModalOpen(true);
              }
          }
      };
      document.addEventListener('click', handleClick, { capture: true });
      return () => document.removeEventListener('click', handleClick, { capture: true });
  }, [hasUnsavedChanges]);

  const updateEditingClient = (key: string, value: any) => {
    setEditingClient((prev: any) => ({ ...prev, [key]: value }));
    if (testResults['clients'] !== null) {
        setTestResults(prev => ({ ...prev, clients: null }));
    }
  };

  useEffect(() => {
    fetch('/api/admin/config').then(res => res.json()).then(data => {
        setConfiguredLibraries(data.libraries || []);
        setConfiguredClients(data.downloadClients || []);
        setConfiguredWebhooks(data.discordWebhooks || []);
        setConfiguredIndexers(data.indexers || []);
        setConfiguredHosters(data.hosterAccounts || []);
        setEnvPaths(data.envPaths || {});
        
        const parsedHeaders = (data.customHeaders || []).map((h: any) => ({ ...h, id: h.id || `tmp_${Math.random()}` }));
        setCustomHeaders(parsedHeaders);

        const parsedAcronyms = (data.searchAcronyms || []).map((a: any) => ({ ...a, id: a.id || `tmp_${Math.random()}` }));
        if (parsedAcronyms.length > 0) {
            setCustomAcronyms(parsedAcronyms);
        } else {
            setCustomAcronyms([
                { id: 'tmp_1', key: 'tmnt', value: 'teenage mutant ninja turtles' },
                { id: 'tmp_2', key: 'asm', value: 'amazing spider-man' },
                { id: 'tmp_3', key: 'f4', value: 'fantastic four' },
                { id: 'tmp_4', key: 'jla', value: 'justice league of america' },
                { id: 'tmp_5', key: 'jl', value: 'justice league' },
                { id: 'tmp_6', key: 'gotg', value: 'guardians of the galaxy' },
                { id: 'tmp_7', key: 'avx', value: 'avengers vs x-men' },
                { id: 'tmp_8', key: 'x-men', value: 'x men' }
            ]);
        }

        const newConfig: any = { ...config };
        if (Array.isArray(data.settings)) {
            data.settings.forEach((item: any) => { 
                if (item.key !== 'omnibus_api_key' && item.key !== 'hoster_priority') {
                    newConfig[item.key] = item.value;
                }
            });

            const hpSetting = data.settings.find((s: any) => s.key === 'hoster_priority');
            const defaultHosters = [
                { hoster: 'mediafire', enabled: true },
                { hoster: 'getcomics', enabled: true },
                { hoster: 'mega', enabled: true },
                { hoster: 'pixeldrain', enabled: true },
                { hoster: 'rootz', enabled: true },
                { hoster: 'vikingfile', enabled: true },
                { hoster: 'terabox', enabled: true },
                { hoster: 'annas_archive', enabled: true }
            ];
            
            if (hpSetting?.value) {
                try { 
                    const savedHosters = JSON.parse(hpSetting.value);
                    let mergedHosters: any[] = [];
                    if (savedHosters.length > 0 && typeof savedHosters[0] === 'string') {
                        mergedHosters = savedHosters.map((h: string) => ({ hoster: h, enabled: true }));
                    } else {
                        mergedHosters = [...savedHosters];
                    }
                    defaultHosters.forEach(dh => {
                        if (!mergedHosters.some(mh => mh.hoster === dh.hoster)) mergedHosters.push(dh);
                    });
                    setHosterPriority(mergedHosters); 
                } catch(e) {
                    setHosterPriority(defaultHosters);
                }
            } else {
                setHosterPriority(defaultHosters);
            }
        }

        if (!newConfig.download_retry_delay) newConfig.download_retry_delay = "5";
        if (!newConfig.prowlarr_categories) newConfig.prowlarr_categories = "7030, 8030";
        if (newConfig.discord_enabled === undefined) newConfig.discord_enabled = "true";
        if (newConfig.oidc_force_sso === undefined) newConfig.oidc_force_sso = "false";
        if (newConfig.oidc_auto_approve === undefined) newConfig.oidc_auto_approve = "false";
        
        setConfig(newConfig);
        setTimeout(() => setIsDataLoaded(true), 500);
    })

    fetch('/api/admin/users').then(res => res.json()).then(data => {
        if (Array.isArray(data)) setUsers(data);
    });
    fetch('/api/admin/api-keys').then(res => res.json()).then(data => {
        if (Array.isArray(data)) setApiKeys(data);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
      if (session?.user?.id && !newKeyUserId && users.length > 0) {
          setNewKeyUserId((session.user as any).id);
      }
  }, [session, users, newKeyUserId]);

  const handleTabChange = (val: string) => {
      setActiveTab(val);
      if (val !== 'api') {
          setGeneratedKey(null);
          setGenerateError(null);
      }
  };

  const handleSave = async () => {
    setLoading(true);

    const payload = { 
        settings: {
            ...config,
            hoster_priority: JSON.stringify(hosterPriority)
        },
        libraries: configuredLibraries,
        indexers: configuredIndexers, 
        customHeaders: customHeaders,
        searchAcronyms: customAcronyms, 
        downloadClients: configuredClients,
        hosterAccounts: configuredHosters,
        discordWebhooks: configuredWebhooks
    }

    try {
        const res = await fetch('/api/admin/config', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        })
        
        if (res.ok) {
            setInitialStateHash(currentStateString);
            toast({ title: "Settings Saved", description: "Configuration persisted to database. Rebuilding Discover cache..." })
            fetch('/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job: 'popular' })
            }).catch(() => {});
        }
    } finally { 
        setLoading(false) 
    }
  }

  // --- NEW: Restore Naming Defaults Function ---
  const handleRestoreNamingDefaults = () => {
    setConfig((prev: any) => ({
        ...prev,
        folder_naming_pattern: "{Publisher}/{Series} ({Year})",
        file_naming_pattern: "{Series} #{Issue}",
        manga_file_naming_pattern: "{Series} Vol. {Issue}"
    }));
    toast({ 
        title: "Defaults Restored", 
        description: "Patterns reset to default. Don't forget to click 'Save All Changes' to apply!" 
    });
  };

  // --- Generic Provider Event Handler ---
  const toggleProviderEvent = (providerKey: string, eventId: string) => {
    let current = [];
    try { current = JSON.parse(config[`${providerKey}_events`] || "[]"); } catch(e){}
    const updated = current.includes(eventId) ? current.filter((e: string) => e !== eventId) : [...current, eventId];
    setConfig({...config, [`${providerKey}_events`]: JSON.stringify(updated)});
  }

  // --- Library Methods ---
  const addLibrary = () => {
    setConfiguredLibraries([...configuredLibraries, {
        id: `tmp_${Date.now()}`, name: "", path: "", isManga: false, isDefault: configuredLibraries.length === 0
    }]);
  }
  const removeLibrary = (id: string) => setConfiguredLibraries(configuredLibraries.filter(l => l.id !== id));
  const updateLibrary = (id: string, field: keyof LibraryConfig, value: any) => {
    setConfiguredLibraries(prev => prev.map(lib => lib.id === id ? { ...lib, [field]: value } : lib));
  }
  const setLibraryDefault = (id: string, isMangaType: boolean) => {
    setConfiguredLibraries(prev => prev.map(lib => {
        if (lib.isManga === isMangaType) return { ...lib, isDefault: lib.id === id };
        return lib;
    }));
  }

  // --- Hoster Methods ---
  const moveHosterPriority = (index: number, direction: -1 | 1) => {
      const newPriority = [...hosterPriority];
      const temp = newPriority[index];
      newPriority[index] = newPriority[index + direction];
      newPriority[index + direction] = temp;
      setHosterPriority(newPriority);
  }

  const toggleHosterEnabled = (index: number) => {
      const newPriority = [...hosterPriority];
      newPriority[index].enabled = !newPriority[index].enabled;
      setHosterPriority(newPriority);
  }

  const openHosterSetup = (hosterName: string) => {
      setEditingHoster({
          id: `tmp_${Math.random().toString(36).substr(2, 9)}`,
          name: hosterDisplayNames[hosterName] || hosterName,
          hoster: hosterName,
          username: "", password: "", apiKey: "",
          isActive: true
      });
      setHosterModalOpen(true);
  }

  const saveHosterInState = () => {
      if (!editingHoster) return;
      setConfiguredHosters(prev => {
          const filtered = prev.filter(c => c.id !== editingHoster.id);
          return [...filtered, editingHoster];
      });
      setHosterModalOpen(false);
      toast({ title: "Account Added", description: "Remember to click 'Save All Changes' above." });
  }

  const deleteHoster = (id: string) => {
      setConfiguredHosters(prev => prev.filter(c => c.id !== id));
      toast({ title: "Account Removed" });
  }

  const applyRecommendedFilters = () => {
      setConfig((prev: any) => ({
          ...prev,
          filter_enabled: "true",
          filter_publishers: RECOMMENDED_PUBLISHERS,
          filter_keywords: RECOMMENDED_KEYWORDS
      }));
      toast({ title: "Filters Applied", description: "NSFW blocklists loaded. Click 'Save All Changes' to apply." });
  }

  const applyForeignFilters = () => {
      setConfig((prev: any) => ({
          ...prev,
          filter_foreign_publishers: "panini, panini espana, panini france, panini comics, panini verlag, urban comics, ecc ediciones, editorial televisa, planeta deagostini, ediciones zinco, norma editorial, panini brasil, panini mexico, panini uk, delcourt, glenat, dargaud, soleil, epsilon"
      }));
      toast({ title: "Filters Applied", description: "Foreign publisher blocklist loaded. Click 'Save All Changes' to apply." });
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

  const openWebhookModal = (webhook?: WebhookConfig) => {
    setTestResults(prev => ({ ...prev, webhooks: null }));
    if (webhook) {
      setEditingWebhook({ ...webhook })
    } else {
      setEditingWebhook({
        id: `tmp_${Math.random().toString(36).substr(2, 9)}`,
        name: "", url: "", events: [], isActive: true,
        botUsername: "", botAvatarUrl: "" 
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
        ? editingWebhook.events.filter((e: string) => e !== eventId) 
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
        id: `tmp_${Math.random().toString(36).substr(2, 9)}`,
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

  const addHeader = (k = "") => setCustomHeaders([...customHeaders, { id: `tmp_${Math.random()}`, key: k, value: "" }])
  const updateHeader = (i: number, f: 'key' | 'value', v: string) => { const h = [...customHeaders]; (h[i] as any)[f] = v; setCustomHeaders(h); }
  const removeHeader = (id: string) => setCustomHeaders(customHeaders.filter(c => c.id !== id))

  const handleGenerateKey = async () => {
      setIsGeneratingKey(true);
      setGeneratedKey(null);
      setGenerateError(null);
      try {
          const res = await fetch('/api/admin/api-keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  name: newKeyName,
                  userId: newKeyUserId || (session?.user as any)?.id,
                  expiresInDays: parseInt(newKeyExpiration)
              })
          });
          const data = await res.json();
          if (res.ok && data.success) {
              setGeneratedKey(data.rawKey);
              setApiKeys([data.apiKey, ...apiKeys]);
              setNewKeyName("");
          } else {
              setGenerateError(data.error || "Failed to generate key");
          }
      } catch (e: any) {
          setGenerateError(e.message);
      } finally {
          setIsGeneratingKey(false);
      }
  }

  const handleRevokeKey = async (id: string) => {
      try {
          const res = await fetch(`/api/admin/api-keys?id=${id}`, { method: 'DELETE' });
          if (res.ok) {
              setApiKeys(prev => prev.filter(k => k.id !== id));
              toast({ title: "API Key Revoked" });
          } else {
              toast({ title: "Error", description: "Failed to revoke key.", variant: "destructive" });
          }
      } catch (e) {
          toast({ title: "Error", variant: "destructive" });
      }
  }

  const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      toast({ title: "Copied!", description: "API Key copied to clipboard." });
  }

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
        <Button 
            onClick={handleSave} 
            disabled={loading} 
            size="lg" 
            className={`w-full sm:w-auto h-12 sm:h-10 font-bold transition-all duration-300 shadow-md ${hasUnsavedChanges ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-[0_0_15px_rgba(245,158,11,0.5)]' : 'bg-primary hover:bg-primary/90 text-primary-foreground'}`}
        >
            <Save className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />
            {hasUnsavedChanges ? "Save Unsaved Changes" : "Save All Changes"}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full space-y-6">
        
        <TabsList className="flex w-full overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] h-auto bg-muted border border-border gap-1 p-1 justify-start lg:justify-center">
          <TabsTrigger value="metadata" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Metadata</TabsTrigger>
          <TabsTrigger value="indexers" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Indexers</TabsTrigger>
          <TabsTrigger value="clients" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Clients</TabsTrigger>
          <TabsTrigger value="hosters" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">File Hosters</TabsTrigger>
          <TabsTrigger value="paths" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Paths</TabsTrigger>
          <TabsTrigger value="network" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Network</TabsTrigger>
          <TabsTrigger value="filters" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Filters</TabsTrigger>
          <TabsTrigger value="alerts" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Alerts</TabsTrigger>
          <TabsTrigger value="api" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">API Keys</TabsTrigger>
          <TabsTrigger value="sso" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">SSO</TabsTrigger>
        </TabsList>

        {/* 1. METADATA PROVIDERS */}
        <TabsContent value="metadata">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Database className="w-5 h-5 text-primary" /> Metadata Providers</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure the sources used to automatically pull covers, synopses, and creator credits for your library.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                    
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
                        <p className="text-[0.8rem] text-muted-foreground">Metron is an open-source alternative to ComicVine.</p>
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
                        
                        {/* --- NEW METRON TEST BUTTON --- */}
                        <div className="border-t border-border my-4" />
                        <Button className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" variant="outline" onClick={() => handleTest('metron')} disabled={!!testing}>
                            {testing === 'metron' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/> : <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test Connection
                        </Button>
                        <StatusBox result={testResults.metron} />
                    </div>

                    {/* --- SERIES.JSON EXPORT --- */}
                    <div className="space-y-4 pt-6 border-t border-border mt-4">
                        <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                            <Switch 
                                id="export-series-json"
                                checked={config.export_series_json === "true"} 
                                onCheckedChange={(c) => setConfig({...config, export_series_json: c ? "true" : "false"})} 
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="export-series-json" className="cursor-pointer font-bold text-base text-foreground">
                                    Export series.json for Komga / Kavita
                                </Label>
                                <p className="text-[11px] text-muted-foreground">
                                    Automatically writes a <code>series.json</code> file to the root of your series folders. This allows external reading servers to instantly recognize your metadata if you map them to the same storage drive.
                                </p>
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
                                {/* Invisible spacer to maintain perfect visual alignment with the left column */}
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
                                    manga_publishers: "viz media, kodansha, yen press, seven seas, shueisha, shogakukan, tokyopop, dark horse manga, vertical, ghost ship, denpa, fakku, j-novel club, sublime, kuma, ize press, square enix, hakusensha, lezhin", 
                                    western_publishers: "marvel, dc comics, image comics, idw publishing, dynamite, boom! studios, valiant, archie, oni press, titan comics, vault comics, awa studios, humanoids, 2000 ad, zenescope"
                                })}
                            >
                                Load Default Lists
                            </Button>
                        </div>
                    </div>
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
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Search Categories (Torznab IDs)</Label>
                        <Input value={config.prowlarr_categories || ""} onChange={(e) => setConfig({...config, prowlarr_categories: e.target.value})} placeholder="e.g. 7030, 8030" className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" />
                        <p className="text-[0.8rem] text-muted-foreground">Standard categories: <strong>7030</strong> (Comics), <strong>8030</strong> (Manga). Use a comma-separated list.</p>
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

        {/* 3.5 FILE HOSTERS */}
        <TabsContent value="hosters">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Server className="w-5 h-5 text-primary" /> Third-Party File Hosters</CardTitle>
                    <CardDescription className="text-muted-foreground">Manage priority and add premium credentials for third-party file hosters (like MediaFire or Mega).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-10">
                    
                    {/* Priority List */}
                    <div className="space-y-4">
                        <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Hoster Priority</h3>
                        <p className="text-xs text-muted-foreground">If multiple hosters are available for a comic, Omnibus will prioritize them in this order. You can also disable hosters you do not want to use.</p>
                        
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
                            {['mediafire', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox', 'annas_archive'].map(type => {
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
                            {configuredHosters.length === 0 ? (
                                <div className="col-span-1 sm:col-span-2 text-center py-10 border-2 border-dashed border-border rounded-xl text-muted-foreground">No hoster accounts configured.</div>
                            ) : (
                                configuredHosters.map((hoster) => (
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
                </CardContent>
            </Card>
        </TabsContent>

        {/* 4. PATHS, ROUTING & MEDIA MANAGEMENT */}
        <TabsContent value="paths" className="space-y-6">
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
                                    Available tags: <code className="bg-muted px-1 rounded border border-border">{"{Publisher}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Series}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Year}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{VolumeYear}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{IssueYear}"}</code>, <code className="bg-muted px-1 rounded border border-border">{"{Issue}"}</code>
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
                                <p className="text-[10px] text-muted-foreground">Use slashes (/) to create sub-folders.</p>
                            </div>
                            
                            <div className="space-y-2">
                                <Label className="text-foreground font-semibold">Standard Comic File Format</Label>
                                <Input 
                                    value={config.file_naming_pattern || "{Series} #{Issue}"} 
                                    onChange={e => setConfig({...config, file_naming_pattern: e.target.value})} 
                                    placeholder="{Series} #{Issue}" 
                                    className="h-12 sm:h-10 font-mono bg-muted/30 border-border text-foreground"
                                />
                                <p className="text-[10px] text-muted-foreground">Applied to standard Western comics.</p>
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
                                            .replace(/{Issue}/gi, "001")
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
                                            .replace(/{Issue}/gi, "001")
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
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_BACKUPS_DIR}>{envPaths?.OMNIBUS_BACKUPS_DIR || '/backups'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Where automated database backups are saved.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><Zap className="w-3 h-3"/> Cache & Temp Dir</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_CACHE_DIR}>{envPaths?.OMNIBUS_CACHE_DIR || '/cache'}</p>
                                    <p className="text-[10px] text-muted-foreground mt-2">Map this to a drive with plenty of free space.</p>
                                </div>
                                <div className="p-4 bg-muted/30 border border-border rounded-lg shadow-sm">
                                    <p className="text-[10px] uppercase font-bold text-muted-foreground mb-1 flex items-center gap-1.5"><FileText className="w-3 h-3"/> Log Directory</p>
                                    <p className="font-mono text-sm font-bold text-primary truncate" title={envPaths?.OMNIBUS_LOGS_DIR}>{envPaths?.OMNIBUS_LOGS_DIR || '/app/config/logs'}</p>
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
        </TabsContent>

        {/* 5. NETWORK */}
        <TabsContent value="network">
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Shield className="w-5 h-5 text-primary" /> Network & Security</CardTitle>
                    <CardDescription className="text-muted-foreground">Configure custom HTTP headers for all outgoing requests and manage connection timeouts/retries.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* --- FLARESOLVERR UI --- */}
                    <div className="space-y-4 pb-6 border-b border-border">
                        <Label className="text-base font-bold text-foreground">Cloudflare Bypass (FlareSolverr)</Label>
                        <p className="text-[11px] text-muted-foreground mt-1">If GetComics starts blocking your automated searches with a 403 Forbidden error, you can route requests through a FlareSolverr container to bypass the protection.</p>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <Input
                                placeholder="http://192.168.1.100:8191"
                                value={config.flaresolverr_url || ""}
                                onChange={e => setConfig({...config, flaresolverr_url: e.target.value})}
                                className="h-12 sm:h-10 bg-background border-border text-foreground flex-1 font-mono text-sm"
                            />
                            <Button variant="outline" onClick={() => handleTest('flaresolverr', { flaresolverr_url: config.flaresolverr_url })} disabled={!!testing} className="h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground">
                                {testing === 'flaresolverr' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin text-primary"/> : <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>} Test FlareSolverr
                            </Button>
                        </div>
                        <StatusBox result={testResults.flaresolverr} />
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
                                <div key={h.id} className="flex flex-col sm:flex-row gap-2 animate-in fade-in slide-in-from-top-1 bg-muted/50 p-2 rounded-md sm:bg-transparent sm:p-0 sm:rounded-none sm:border-0 border border-border">
                                    <Input placeholder="Header Name" value={h.key} onChange={e => updateHeader(i, 'key', e.target.value)} className="h-12 sm:h-10 bg-background border-border text-foreground" />
                                    <div className="flex gap-2 w-full">
                                      <Input type="password" placeholder="Header Value" value={h.value} onChange={e => updateHeader(i, 'value', e.target.value)} className="h-12 sm:h-10 flex-1 bg-background border-border text-foreground" />
                                      <Button variant="ghost" size="icon" onClick={() => removeHeader(h.id!)} className="h-12 w-12 sm:h-10 sm:w-10 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200"><Trash2 className="h-5 h-5 sm:h-4 sm:w-4"/></Button>
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
                    
                    {/* Discover Page Sections */}
                    <div className="flex flex-col space-y-4 bg-muted/30 p-4 rounded-lg border border-border">
                        <Label className="text-base font-bold text-foreground">Discover Page Sections</Label>
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center space-x-2">
                                <Switch 
                                    id="popular-toggle"
                                    checked={config.show_popular_issues !== "false"} 
                                    onCheckedChange={(c) => setConfig({...config, show_popular_issues: c ? "true" : "false"})} 
                                />
                                <Label htmlFor="popular-toggle" className="cursor-pointer font-bold text-sm text-foreground">Show Popular Issues</Label>
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
                            {/* --- NEW FOREIGN BLOCKLIST TEXTAREA --- */}
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

                    {/* Acronym Customization */}
                    <div className="space-y-4 pt-6 border-t border-border">
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
        </TabsContent>

        {/* 7. ALERTS (NOTIFICATION PROVIDERS) */}
        <TabsContent value="alerts">
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-foreground">Notification Providers</h2>
              <p className="text-sm text-muted-foreground mt-1">Select and configure the services you want to use to receive automated system alerts.</p>
            </div>

            {/* --- 1. DISCORD --- */}
            <Card className="shadow-sm border-border bg-background">
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2 text-foreground">
                      <Webhook className="w-5 h-5 text-primary" /> Discord
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">
                      Configure automated server alerts using Discord Webhooks.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-4">
                    <Switch 
                        checked={config.discord_enabled !== "false"} 
                        onCheckedChange={(c) => setConfig({...config, discord_enabled: c ? "true" : "false"})} 
                    />
                    {config.discord_enabled !== "false" && (
                        <Button variant="outline" size="sm" onClick={() => openWebhookModal()} className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground transition-colors">
                          <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary" /> Add Webhook
                        </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              
              {config.discord_enabled !== "false" && (
              <CardContent className="space-y-6 border-t border-border pt-6 animate-in fade-in slide-in-from-top-2">
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
              </CardContent>
              )}
            </Card>

            {/* --- 2. PUSHOVER --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-foreground"><Smartphone className="w-5 h-5 text-primary" /> Pushover</CardTitle>
                            <CardDescription className="text-muted-foreground">Receive instant push notifications on your iOS or Android devices.</CardDescription>
                        </div>
                        <Switch checked={config.pushover_enabled === "true"} onCheckedChange={(c) => setConfig({...config, pushover_enabled: c ? "true" : "false"})} />
                    </div>
                </CardHeader>
                {config.pushover_enabled === "true" && (
                <CardContent className="space-y-4 animate-in fade-in slide-in-from-top-2 border-t border-border pt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="grid gap-2"><Label>Application Token</Label><Input value={config.pushover_token} onChange={e => setConfig({...config, pushover_token: e.target.value})} placeholder="API Token/Key" className="bg-muted/20 border-border" /></div>
                        <div className="grid gap-2"><Label>User/Group Key</Label><Input value={config.pushover_user} onChange={e => setConfig({...config, pushover_user: e.target.value})} placeholder="User Key" className="bg-muted/20 border-border" /></div>
                    </div>
                    <div className="space-y-3 pt-2">
                        <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                        <div className="grid sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto bg-muted/20 p-4 border border-border rounded-lg">
                            {SYSTEM_EVENTS.map(event => {
                                const isActive = (JSON.parse(config.pushover_events || "[]") as string[]).includes(event.id);
                                return (
                                <div key={event.id} className="flex items-start space-x-3 p-2 rounded hover:bg-background border border-transparent hover:border-border transition-colors group">
                                    <Checkbox id={`po_${event.id}`} checked={isActive} onCheckedChange={() => toggleProviderEvent('pushover', event.id)} className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary" />
                                    <label htmlFor={`po_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">{event.label}</label>
                                </div>
                            )})}
                        </div>
                    </div>
                    <Button variant="outline" className="w-full sm:w-auto mt-2 border-border font-bold hover:bg-muted" onClick={() => handleTest('pushover', config)} disabled={!!testing}>
                        {testing === 'pushover' ? <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" /> : <Send className="w-4 h-4 mr-2 text-primary" />} Test Pushover
                    </Button>
                    <StatusBox result={testResults.pushover} />
                </CardContent>
                )}
            </Card>

            {/* --- 3. TELEGRAM --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-foreground"><Send className="w-5 h-5 text-primary" /> Telegram</CardTitle>
                            <CardDescription className="text-muted-foreground">Send Omnibus alerts directly to a Telegram chat or channel.</CardDescription>
                        </div>
                        <Switch checked={config.telegram_enabled === "true"} onCheckedChange={(c) => setConfig({...config, telegram_enabled: c ? "true" : "false"})} />
                    </div>
                </CardHeader>
                {config.telegram_enabled === "true" && (
                <CardContent className="space-y-4 animate-in fade-in slide-in-from-top-2 border-t border-border pt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="grid gap-2"><Label>Bot Token</Label><Input value={config.telegram_bot_token} onChange={e => setConfig({...config, telegram_bot_token: e.target.value})} placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" className="bg-muted/20 border-border" /></div>
                        <div className="grid gap-2"><Label>Chat ID</Label><Input value={config.telegram_chat_id} onChange={e => setConfig({...config, telegram_chat_id: e.target.value})} placeholder="-1001234567890" className="bg-muted/20 border-border" /></div>
                    </div>
                    <div className="space-y-3 pt-2">
                        <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                        <div className="grid sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto bg-muted/20 p-4 border border-border rounded-lg">
                            {SYSTEM_EVENTS.map(event => {
                                const isActive = (JSON.parse(config.telegram_events || "[]") as string[]).includes(event.id);
                                return (
                                <div key={event.id} className="flex items-start space-x-3 p-2 rounded hover:bg-background border border-transparent hover:border-border transition-colors group">
                                    <Checkbox id={`tg_${event.id}`} checked={isActive} onCheckedChange={() => toggleProviderEvent('telegram', event.id)} className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary" />
                                    <label htmlFor={`tg_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">{event.label}</label>
                                </div>
                            )})}
                        </div>
                    </div>
                    <Button variant="outline" className="w-full sm:w-auto mt-2 border-border font-bold hover:bg-muted" onClick={() => handleTest('telegram', config)} disabled={!!testing}>
                        {testing === 'telegram' ? <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" /> : <Send className="w-4 h-4 mr-2 text-primary" />} Test Telegram
                    </Button>
                    <StatusBox result={testResults.telegram} />
                </CardContent>
                )}
            </Card>

            {/* --- 4. APPRISE --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-foreground"><Globe className="w-5 h-5 text-primary" /> Apprise</CardTitle>
                            <CardDescription className="text-muted-foreground">Route notifications through an Apprise instance to support 80+ other services.</CardDescription>
                        </div>
                        <Switch checked={config.apprise_enabled === "true"} onCheckedChange={(c) => setConfig({...config, apprise_enabled: c ? "true" : "false"})} />
                    </div>
                </CardHeader>
                {config.apprise_enabled === "true" && (
                <CardContent className="space-y-4 animate-in fade-in slide-in-from-top-2 border-t border-border pt-6">
                    <div className="grid gap-2"><Label>Apprise URL</Label><Input value={config.apprise_url} onChange={e => setConfig({...config, apprise_url: e.target.value})} placeholder="http://apprise:8000/notify/apprise" className="bg-muted/20 border-border" /></div>
                    <div className="space-y-3 pt-2">
                        <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                        <div className="grid sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto bg-muted/20 p-4 border border-border rounded-lg">
                            {SYSTEM_EVENTS.map(event => {
                                const isActive = (JSON.parse(config.apprise_events || "[]") as string[]).includes(event.id);
                                return (
                                <div key={event.id} className="flex items-start space-x-3 p-2 rounded hover:bg-background border border-transparent hover:border-border transition-colors group">
                                    <Checkbox id={`ap_${event.id}`} checked={isActive} onCheckedChange={() => toggleProviderEvent('apprise', event.id)} className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary" />
                                    <label htmlFor={`ap_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">{event.label}</label>
                                </div>
                            )})}
                        </div>
                    </div>
                    <Button variant="outline" className="w-full sm:w-auto mt-2 border-border font-bold hover:bg-muted" onClick={() => handleTest('apprise', config)} disabled={!!testing}>
                        {testing === 'apprise' ? <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" /> : <Globe className="w-4 h-4 mr-2 text-primary" />} Test Apprise
                    </Button>
                    <StatusBox result={testResults.apprise} />
                </CardContent>
                )}
            </Card>

            {/* --- 5. EMAIL --- */}
            <Card className="shadow-sm border-border bg-background mt-6">
                <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-foreground">
                            <Mail className="w-5 h-5 text-primary" /> SMTP Email Alerts
                        </CardTitle>
                        <CardDescription className="text-muted-foreground mt-1">Configure an SMTP server to send email notifications for approvals and fulfilled requests.</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" asChild className="h-12 sm:h-9 font-bold border-border hover:bg-muted text-foreground transition-colors w-full sm:w-auto">
                        <Link href="/admin/email-templates"><FileEdit className="w-4 h-4 mr-2 text-primary" /> Customize Templates</Link>
                    </Button>
                </div>
                </CardHeader>
                <CardContent className="space-y-6 border-t border-border pt-6">
                <div className="flex items-center space-x-2">
                    <Switch checked={config.smtp_enabled === "true"} onCheckedChange={(c) => setConfig({...config, smtp_enabled: c ? "true" : "false"})} />
                    <Label className="cursor-pointer font-bold">Enable Email Notifications</Label>
                </div>
                {config.smtp_enabled === "true" && (
                    <div className="grid gap-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="grid gap-2"><Label>SMTP Host</Label><Input value={config.smtp_host} onChange={e => setConfig({...config, smtp_host: e.target.value})} placeholder="smtp.gmail.com" className="bg-muted/20 border-border text-foreground" /></div>
                            <div className="grid gap-2"><Label>SMTP Port</Label><Input value={config.smtp_port} onChange={e => setConfig({...config, smtp_port: e.target.value})} placeholder="587" className="bg-muted/20 border-border text-foreground" /></div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="grid gap-2"><Label>SMTP Username</Label><Input value={config.smtp_user} onChange={e => setConfig({...config, smtp_user: e.target.value})} placeholder="user@gmail.com" className="bg-muted/20 border-border text-foreground" /></div>
                            <div className="grid gap-2"><Label>SMTP Password</Label><Input type="password" value={config.smtp_pass} onChange={e => setConfig({...config, smtp_pass: e.target.value})} placeholder="App Password" className="bg-muted/20 border-border text-foreground" /></div>
                        </div>
                        <div className="grid gap-2"><Label>From Email Address</Label><Input value={config.smtp_from} onChange={e => setConfig({...config, smtp_from: e.target.value})} placeholder="omnibus@yourdomain.com" className="bg-muted/20 border-border text-foreground" /></div>
                        
                        <div className="border-t border-border pt-4 flex flex-col sm:flex-row gap-2">
                            <Input id="smtp-test-email" placeholder="Send test email to..." className="bg-muted/20 border-border max-w-xs text-foreground flex-1 sm:flex-none" />
                            <div className="flex gap-2">
                                <Button variant="outline" className="border-border hover:bg-muted text-foreground flex-1 sm:flex-none" onClick={() => {
                                    const testEmail = (document.getElementById('smtp-test-email') as HTMLInputElement)?.value;
                                    if (testEmail) handleTest('smtp', { ...config, test_email: testEmail });
                                    else toast({ title: "Validation Error", description: "Enter an email to test.", variant: "destructive" });
                                }} disabled={!!testing}>
                                    {testing === 'smtp' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />} Test SMTP
                                </Button>
                                <Button variant="outline" className="border-primary/30 text-primary bg-primary/10 hover:bg-primary/20 flex-1 sm:flex-none" onClick={() => {
                                    const testEmail = (document.getElementById('smtp-test-email') as HTMLInputElement)?.value;
                                    if (testEmail) handleTest('smtp_digest', { ...config, test_email: testEmail });
                                    else toast({ title: "Validation Error", description: "Enter an email to test.", variant: "destructive" });
                                }} disabled={!!testing}>
                                    {testing === 'smtp_digest' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FileText className="w-4 h-4 mr-2" />} Test Weekly Digest
                                </Button>
                            </div>
                        </div>
                        <StatusBox result={testResults.smtp || testResults.smtp_digest} />
                    </div>
                )}
                </CardContent>
            </Card>

          </div>
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

                    {config.oidc_enabled === "true" && (
                        <div className="grid gap-4 p-6 border dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/50 animate-in fade-in zoom-in-95">
                            <div className="grid gap-2"><Label>Issuer URL</Label><Input placeholder="https://auth.yourdomain.com" value={config.oidc_issuer || ""} onChange={e => setConfig({...config, oidc_issuer: e.target.value})} className="bg-white dark:bg-slate-900" /></div>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <div className="grid gap-2"><Label>Client ID</Label><Input value={config.oidc_client_id || ""} onChange={e => setConfig({...config, oidc_client_id: e.target.value})} className="bg-white dark:bg-slate-900" /></div>
                                <div className="grid gap-2"><Label>Client Secret</Label><Input type="password" value={config.oidc_client_secret || ""} onChange={e => setConfig({...config, oidc_client_secret: e.target.value})} className="bg-white dark:bg-slate-900" /></div>
                            </div>
                            
                            <div className="border-t border-slate-200 dark:border-slate-800 pt-6 mt-4">
                                <h3 className="text-base font-bold text-foreground mb-4">SSO Behavior Options</h3>
                                <div className="grid gap-6">
                                    <div className="flex items-center space-x-2">
                                        <Switch 
                                            id="oidc-force-sso"
                                            checked={config.oidc_force_sso === "true"} 
                                            onCheckedChange={(c) => setConfig({...config, oidc_force_sso: c ? "true" : "false"})} 
                                        />
                                        <div className="grid gap-1">
                                            <Label htmlFor="oidc-force-sso" className="cursor-pointer font-bold">Disable Native Login (Force SSO)</Label>
                                            <p className="text-xs text-muted-foreground">Completely removes the local username/password form and auto-redirects users to your Identity Provider. Admins can bypass this by appending <code className="font-bold">?local=true</code> to the login URL.</p>
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center space-x-2">
                                        <Switch 
                                            id="oidc-auto-approve"
                                            checked={config.oidc_auto_approve === "true"} 
                                            onCheckedChange={(c) => setConfig({...config, oidc_auto_approve: c ? "true" : "false"})} 
                                        />
                                        <div className="grid gap-1">
                                            <Label htmlFor="oidc-auto-approve" className="cursor-pointer font-bold">Auto-Approve New Logins</Label>
                                            <p className="text-xs text-muted-foreground">Allows users to bypass the manual admin approval stage if they successfully log in via SSO.</p>
                                        </div>
                                    </div>
                                </div>
                                
                                {/* --- NEW: BLANKET AUTO-APPROVE WARNING --- */}
                                {config.oidc_auto_approve === 'true' && !config.oidc_admin_group && !config.oidc_user_group && (
                                    <Alert className="bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/50 mt-6">
                                        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                                        <AlertTitle className="text-amber-800 dark:text-amber-300 font-bold">Security Warning: Blanket Approvals</AlertTitle>
                                        <AlertDescription className="text-amber-700/90 dark:text-amber-400/90">
                                            You have enabled Auto-Approve without specifying any Group Mappings. 
                                            <strong> This means ANYONE with an account on your Identity Provider can log in to Omnibus.</strong> 
                                            Only use this if your IdP strictly restricts access to the Omnibus application.
                                        </AlertDescription>
                                    </Alert>
                                )}
                            </div>

                            <div className="border-t border-slate-200 dark:border-slate-800 pt-6 mt-4">
                                <h3 className="text-base font-bold text-foreground mb-4">Group Mapping (Optional)</h3>
                                <p className="text-xs text-muted-foreground mb-4">
                                    If your Identity Provider sends a <code>groups</code> or <code>roles</code> claim, Omnibus can automatically assign user privileges.
                                    If you configure groups here, <strong>only users in these groups will be allowed to log in.</strong>
                                </p>
                                <div className="grid sm:grid-cols-2 gap-4">
                                    <div className="grid gap-2">
                                        <Label>Admin Group Name</Label>
                                        <Input 
                                            placeholder="e.g. OmnibusAdmins" 
                                            value={config.oidc_admin_group || ""} 
                                            onChange={e => setConfig({...config, oidc_admin_group: e.target.value})} 
                                            className="bg-white dark:bg-slate-900" 
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label>Standard User Group Name</Label>
                                        <Input 
                                            placeholder="e.g. OmnibusUsers" 
                                            value={config.oidc_user_group || ""} 
                                            onChange={e => setConfig({...config, oidc_user_group: e.target.value})} 
                                            className="bg-white dark:bg-slate-900" 
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="border-t border-slate-200 dark:border-slate-800 pt-6 mt-4">
                                <Label className="text-sm font-bold text-rose-500 mb-2 block">Redirect URI Setup</Label>
                                <p className="text-[12px] text-muted-foreground mb-2">You must add this exact Redirect URI to your OIDC provider's client configuration:</p>
                                <Input readOnly value={typeof window !== 'undefined' ? `${window.location.origin}/api/auth/callback/oidc` : ''} className="font-mono text-xs text-muted-foreground bg-slate-100 dark:bg-slate-900 border-dashed border-slate-300 dark:border-slate-700" />
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </TabsContent>

        {/* 8. API KEYS */}
        <TabsContent value="api">
            <Card className="shadow-sm border-border bg-background mb-6">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Webhook className="w-5 h-5 text-primary" /> External API Integrations</CardTitle>
                    <CardDescription className="text-muted-foreground">Generate API keys to allow external applications (like Discord Bots or Homepage Dashboards) to fetch stats and interact with Omnibus securely.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="grid gap-2">
                            <Label>Key Name</Label>
                            <Input value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="e.g., Homepage Dashboard" className="bg-muted/20 border-border h-10" />
                        </div>
                        <div className="grid gap-2">
                            <Label>Acts As (User)</Label>
                            <Select value={newKeyUserId} onValueChange={setNewKeyUserId}>
                                <SelectTrigger className="h-10 bg-muted/20 border-border"><SelectValue placeholder="Select user" /></SelectTrigger>
                                <SelectContent className="bg-popover border-border">
                                    {users.map(u => <SelectItem key={u.id} value={u.id}>{u.username}</SelectItem>)}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2">
                            <Label>Expiration</Label>
                            <Select value={newKeyExpiration} onValueChange={setNewKeyExpiration}>
                                <SelectTrigger className="h-10 bg-muted/20 border-border"><SelectValue /></SelectTrigger>
                                <SelectContent className="bg-popover border-border">
                                    <SelectItem value="0">Never</SelectItem>
                                    <SelectItem value="7">7 Days</SelectItem>
                                    <SelectItem value="30">30 Days</SelectItem>
                                    <SelectItem value="90">90 Days</SelectItem>
                                    <SelectItem value="365">1 Year</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    
                    <Button onClick={handleGenerateKey} disabled={!newKeyName || isGeneratingKey} className="font-bold h-10 bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm">
                        {isGeneratingKey ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />} Generate New Key
                    </Button>

                    {generatedKey && (
                        <div className="bg-green-50 border border-green-200 text-green-800 p-4 rounded-lg flex flex-col gap-2 relative dark:bg-green-900/20 dark:border-green-800 dark:text-green-400 mt-4 animate-in fade-in slide-in-from-top-2 w-full">
                            <button onClick={() => setGeneratedKey(null)} className="absolute top-2 right-2 hover:bg-green-200 dark:hover:bg-green-800 p-1 rounded"><XCircle className="w-4 h-4"/></button>
                            <p className="font-bold flex items-center gap-2 pr-6"><CheckCircle2 className="w-5 h-5 shrink-0"/> <span className="leading-tight">Token created! Copy it now — it won't be shown again.</span></p>
                            <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center mt-2 w-full">
                                <code className="bg-white dark:bg-black p-2 rounded flex-1 font-mono border border-green-200 dark:border-green-800 text-[11px] sm:text-xs select-all w-full min-w-0 break-all">
                                    {generatedKey}
                                </code>
                                <Button variant="secondary" onClick={() => copyToClipboard(generatedKey)} className="shrink-0 w-full sm:w-auto h-9 sm:h-auto"><Copy className="w-4 h-4 mr-2" /> Copy</Button>
                            </div>
                        </div>
                    )}
                    {generateError && (
                        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg flex flex-col gap-2 relative dark:bg-red-900/20 dark:border-red-800 dark:text-red-400 mt-4">
                            <button onClick={() => setGenerateError(null)} className="absolute top-2 right-2 hover:bg-red-200 dark:hover:bg-red-800 p-1 rounded"><X className="w-4 h-4"/></button>
                            <p className="font-bold flex items-center gap-2"><AlertCircle className="w-5 h-5"/> Failed to create token</p>
                            <p className="text-sm">{generateError}</p>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="text-lg">Active API Keys</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-muted/50 border-b border-border text-muted-foreground font-medium uppercase text-xs tracking-wider">
                                <tr>
                                    <th className="px-4 py-3">Name</th>
                                    <th className="px-4 py-3">Token</th>
                                    <th className="px-4 py-3">Acts As</th>
                                    <th className="px-4 py-3">Role</th>
                                    <th className="px-4 py-3">Created By</th>
                                    <th className="px-4 py-3">Last Used</th>
                                    <th className="px-4 py-3">Expiration</th>
                                    <th className="px-4 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {apiKeys.length === 0 ? (
                                    <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground italic">No API keys generated yet.</td></tr>
                                ) : (
                                    apiKeys.map(key => (
                                        <tr key={key.id} className="hover:bg-muted/30 transition-colors">
                                            <td className="px-4 py-3 font-bold text-foreground">{key.name}</td>
                                            <td className="px-4 py-3 font-mono text-muted-foreground">{key.prefix}</td>
                                            <td className="px-4 py-3 text-foreground font-medium">{key.user?.username || "Unknown"}</td>
                                            <td className="px-4 py-3">
                                                <Badge variant="secondary" className="text-[10px] uppercase tracking-wider bg-muted text-muted-foreground border-border">{key.user?.role || "USER"}</Badge>
                                            </td>
                                            <td className="px-4 py-3 text-muted-foreground">{key.createdBy?.username || "Unknown"}</td>
                                            <td className="px-4 py-3 text-muted-foreground">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}</td>
                                            <td className="px-4 py-3 text-muted-foreground">
                                                {key.expiresAt ? (
                                                    new Date(key.expiresAt) < new Date() ? <span className="text-red-500 font-bold">Expired</span> : new Date(key.expiresAt).toLocaleDateString()
                                                ) : 'Never'}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => handleRevokeKey(key.id)}>
                                                    Revoke
                                                </Button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                    <div className="flex justify-between items-center mt-4">
                        <Button variant="outline" asChild className="h-10 border-border hover:bg-muted text-foreground transition-all">
                            <Link href="/admin/api-guide">
                                View API Documentation
                            </Link>
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </TabsContent>

      </Tabs>

      {/* --- MODALS --- */}

      {/* HOSTER MODAL */}
      <Dialog open={hosterModalOpen} onOpenChange={setHosterModalOpen}>
        <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl shadow-2xl transition-colors duration-300">
            <DialogHeader><DialogTitle className="text-foreground">Configure {editingHoster?.name}</DialogTitle></DialogHeader>
            {editingHoster && (
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Account Username (Optional)</Label>
                        <Input value={editingHoster.username || ""} onChange={e => setEditingHoster({...editingHoster, username: e.target.value})} placeholder="email@example.com" className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                    </div>
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Account Password (Optional)</Label>
                        <Input type="password" value={editingHoster.password || ""} onChange={e => setEditingHoster({...editingHoster, password: e.target.value})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                    </div>
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">API / Session Key (Optional)</Label>
                        <Input type="password" value={editingHoster.apiKey || ""} onChange={e => setEditingHoster({...editingHoster, apiKey: e.target.value})} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-2">
                        Providing credentials allows Omnibus to bypass guest bandwidth limits on supported file hosters. Leave blank to attempt anonymous downloads.
                    </p>
                </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setHosterModalOpen(false)}>Cancel</Button>
                <Button className="h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md" onClick={saveHosterInState}>Save Account</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>
      
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

              {/* --- CUSTOM USERNAME AND AVATAR INPUTS --- */}
              <div className="grid sm:grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label className="text-xs font-bold uppercase text-muted-foreground">Bot Username (Optional)</Label>
                    <Input 
                      placeholder="e.g. Omnibus Bot" 
                      value={editingWebhook.botUsername || ""} 
                      onChange={e => setEditingWebhook({ ...editingWebhook, botUsername: e.target.value })}
                      className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" 
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs font-bold uppercase text-muted-foreground">Avatar URL (Optional)</Label>
                    <Input 
                      placeholder="https://..." 
                      value={editingWebhook.botAvatarUrl || ""} 
                      onChange={e => setEditingWebhook({ ...editingWebhook, botAvatarUrl: e.target.value })}
                      className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" 
                    />
                  </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-border">
                <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                <div className="grid gap-2 max-h-[250px] overflow-y-auto pr-2">
                  {SYSTEM_EVENTS.map(event => (
                    <div key={event.id} className="flex items-start space-x-3 p-2 sm:p-2 rounded hover:bg-muted/50 border border-transparent hover:border-border transition-colors group">
                      <Checkbox 
                        id={`wh_${event.id}`} 
                        checked={editingWebhook.events.includes(event.id)}
                        onCheckedChange={() => toggleWebhookEvent(event.id)}
                        className="mt-1 sm:mt-0 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                      />
                      <div className="grid gap-1.5 leading-none">
                        <label htmlFor={`wh_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">
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
                        <Input value={editingClient.url} onChange={e => updateEditingClient('url', e.target.value)} placeholder="http://192.168.1.100:8080" className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                    </div>

                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">Download Category / Label</Label>
                        <Input value={editingClient.category || ""} onChange={e => updateEditingClient('category', e.target.value)} placeholder="e.g. comics, manga" className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                        <p className="text-[11px] text-muted-foreground">Comma-separated list of categories to track. New downloads use the first one. <strong className="text-orange-500">Categories MUST exist in your client!</strong></p>
                    </div>

                    <div className="border-t border-border pt-4 mt-2">
                        <div className="flex items-center gap-2 mb-3">
                            <FolderOpen className="w-4 h-4 text-primary" />
                            <Label className="font-bold text-xs uppercase text-muted-foreground">Docker Path Mapping</Label>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label className="text-[11px] text-muted-foreground">Remote Path (Client)</Label>
                                <Input className="h-12 sm:h-10 text-xs font-mono bg-background border-border text-foreground" value={editingClient.remotePath || ""} onChange={e => updateEditingClient('remotePath', e.target.value)} placeholder="/downloads/comics" />
                            </div>
                            <div className="grid gap-2">
                                <Label className="text-[11px] text-muted-foreground">Local Path (Omnibus)</Label>
                                <Input className="h-12 sm:h-10 text-xs font-mono bg-background border-border text-foreground" value={editingClient.localPath || ""} onChange={e => updateEditingClient('localPath', e.target.value)} placeholder="/data/downloads" />
                            </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-2">
                            Use this if Omnibus and the Download Client see different paths (e.g. Docker volumes).
                        </p>
                    </div>

                    {['qbit', 'deluge', 'nzbget'].includes(editingClient.type) && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2 border-t border-border pt-4">
                            <div className="grid gap-2"><Label className="text-foreground font-semibold">User</Label><Input value={editingClient.user} onChange={e => updateEditingClient('user', e.target.value)} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" /></div>
                            <div className="grid gap-2"><Label className="text-foreground font-semibold">Pass</Label><Input type="password" value={editingClient.pass} onChange={e => updateEditingClient('pass', e.target.value)} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" /></div>
                        </div>
                    )}
                    {['sab'].includes(editingClient.type) && (
                        <div className="grid gap-2 mt-2 border-t border-border pt-4"><Label className="text-foreground font-semibold">API Key</Label><Input value={editingClient.apiKey || ""} onChange={e => updateEditingClient('apiKey', e.target.value)} className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" /></div>
                    )}
                    <div className="border-t border-border pt-4">
                        <Button 
                          variant="outline" 
                          className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors" 
                          onClick={() => handleTest('clients', { clientType: editingClient.type, ...editingClient })} 
                          disabled={!!testing || !editingClient.url}
                        >
                          {testing === 'clients' ? (
                            <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary"/>
                          ) : testResults['clients']?.success ? (
                            <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-green-500"/>
                          ) : (
                            <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary"/>
                          )} 
                          {testResults['clients']?.success ? "Connection Verified!" : "Test Connection"}
                        </Button>
                    </div>
                </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setClientModalOpen(false)}>Cancel</Button>
                <Button className="h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md" onClick={saveClientInState}>Save Settings</Button>
            </DialogFooter>
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
            <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setIndexerModalOpen(false)}>Cancel</Button>
                <Button className="h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md" onClick={saveIndexerConfig}>Save Settings</Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- UNSAVED CHANGES DIALOG --- */}
      <ConfirmationDialog 
        isOpen={unsavedModalOpen}
        onClose={() => {
            setUnsavedModalOpen(false);
            setPendingNavigation(null);
        }}
        onConfirm={() => {
            setUnsavedModalOpen(false);
            setInitialStateHash(currentStateString); // Trick the dirty state tracker
            if (pendingNavigation) {
                router.push(pendingNavigation);
            }
        }}
        title="Unsaved Changes"
        description="You have unsaved changes on this page. If you leave now, all your recent modifications will be lost. Are you sure you want to leave?"
        confirmText="Discard Changes & Leave"
        cancelText="Stay on Page"
        variant="destructive"
      />

    </div>
  )
}