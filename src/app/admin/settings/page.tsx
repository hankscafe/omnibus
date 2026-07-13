// src/app/admin/settings/page.tsx
// Settings shell after the Phase 1 reorganization: owns ALL state, the save pipeline, and the
// shared modals; the tab bodies live in ./tabs/*.tsx and consume the state bag `s` below.
"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { DEFAULT_SCORING_RULES } from "@/lib/utils/defaults"
import { RECOMMENDED_PUBLISHERS, RECOMMENDED_KEYWORDS } from "@/lib/filter-defaults"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Save, ArrowLeft, Loader2, CheckCircle, Zap, FolderOpen } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { copyText } from "@/lib/utils/clipboard"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { StatusBox, SYSTEM_EVENTS, hosterDisplayNames } from "./tabs/shared"
import { MetadataTab } from "./tabs/metadata-tab"
import { LibraryFilesTab } from "./tabs/library-files-tab"
import { SearchIndexersTab } from "./tabs/search-indexers-tab"
import { DownloadsTab } from "./tabs/downloads-tab"
import { DiscoveryTab } from "./tabs/discovery-tab"
import { NotificationsTab } from "./tabs/notifications-tab"
import { AccessSecurityTab } from "./tabs/access-security-tab"
import { SystemTab } from "./tabs/system-tab"

import type { LibraryConfig, IndexerConfig, CustomHeader, AcronymConfig, ScoringRule, ClientConfig, WebhookConfig, HosterAccountConfig } from "./tabs/shared"

// --- Constants & Global Mappings ---
// RECOMMENDED_PUBLISHERS / RECOMMENDED_KEYWORDS now live in @/lib/filter-defaults (shared with the setup wizard).

export default function SettingsPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null)
  
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
  const [scoringRules, setScoringRules] = useState<ScoringRule[]>([])
  const [envPaths, setEnvPaths] = useState<any>({})
  
  // Hoster States
  const [configuredHosters, setConfiguredHosters] = useState<HosterAccountConfig[]>([])
  const [hosterPriority, setHosterPriority] = useState<{hoster: string, enabled: boolean}[]>([
      { hoster: 'getcomics_direct', enabled: true },
      { hoster: 'getcomics_main', enabled: true },
      { hoster: 'mediafire', enabled: true },
      { hoster: 'mega', enabled: true },
      { hoster: 'pixeldrain', enabled: true },
      { hoster: 'rootz', enabled: false },
      { hoster: 'vikingfile', enabled: false },
      { hoster: 'terabox', enabled: false }
  ])
  // Automation search-source order (which source is tried first; separate from hoster-mirror priority).
  const [searchSourcePriority, setSearchSourcePriority] = useState<{source: string, enabled: boolean}[]>([
      { source: 'getcomics', enabled: true },
      { source: 'annas_archive', enabled: false },
      { source: 'prowlarr', enabled: true }
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
    primary_metadata_source: "COMICVINE",
    prowlarr_url: "", prowlarr_key: "", prowlarr_categories: "7030", download_path: "", cv_api_key: "",
    metron_user: "", metron_pass: "",
    export_series_json: "true",
    metadata_write_comicinfo: "true",
    cover_source: "metadata",
    series_ended_months: "18",
    remote_path_mapping: "", local_path_mapping: "", flaresolverr_url: "", flaresolverr_timeout: "300",
    filter_enabled: "false", filter_publishers: "", filter_keywords: "",
    filter_foreign_publishers: "",
    filter_junk_words: "", filter_match_ratio: "60", filter_exclude_groups: "",
    show_popular_issues: "true", show_new_releases: "true", 
    manga_publishers: "", western_publishers: "",
    discover_manga_filter_mode: "SHOW_ALL", discover_manga_allowed_publishers: "",
    manga_requests_enabled: "true",
    download_retry_delay: "5",
    awaiting_retry_days: "7", flag_stalled_requests: "true",
    matcher_mode: "confirm", matcher_auto_threshold: "0.90", file_metadata_priority: "false",
    unmatched_sweep_schedule: "1",
    metron_detail_credits: "false",
    metadata_cache_enabled: "false", metadata_cache_detail_days: "7", metadata_cache_list_hours: "12", metadata_cache_max_mb: "256",
    gc_avoid_large_downloads: "true",
    prowlarr_accept_yearless: "false",
    convert_to_webp: "false", webp_quality: "80", cbr_conversion_enabled: "true",
    oidc_enabled: "false", oidc_issuer: "", oidc_client_id: "", oidc_client_secret: "",
    oidc_force_sso: "false", oidc_auto_approve: "false", oidc_admin_group: "", oidc_user_group: "",
    folder_naming_pattern: "", file_naming_pattern: "", manga_file_naming_pattern: "",
    smtp_enabled: "false", smtp_host: "", smtp_port: "", smtp_user: "", smtp_pass: "", smtp_from: "",
    discord_enabled: "true",
    pushover_enabled: "false", pushover_token: "", pushover_user: "", pushover_events: "[]",
    telegram_enabled: "false", telegram_bot_token: "", telegram_chat_id: "", telegram_events: "[]",
    apprise_enabled: "false", apprise_url: "", apprise_events: "[]",
    allow_bulk_packs: "false",
    prioritize_packs: "false",
    ddl_enabled: "true",
    getcomics_interactive_pages: "4",
    getcomics_automated_pages: "5",
    annas_archive_interactive_enabled: "false", annas_archive_base_url: "", annas_archive_formats: "cbz,cbr,pdf,epub",
    engine_max_scan_workers: "", engine_max_convert_workers: "", engine_cpu_cap: "",
    engine_max_blocking_threads: "", engine_memory_ceiling_mb: "", engine_max_db_connections: ""
  })

  const [customProwlarrCategories, setCustomProwlarrCategories] = useState("")

  // --- Shared CV/Metron response cache (Settings → Metadata): live stats + manual clear ---
  const [cacheStats, setCacheStats] = useState<{ entries: number, bytes: number } | null>(null)
  const [clearingCache, setClearingCache] = useState(false)

  const loadCacheStats = () => {
    fetch('/api/admin/metadata-cache')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && !d.error) setCacheStats(d) })
      .catch(() => {})
  }
  useEffect(() => { loadCacheStats() }, [])

  const clearMetadataCache = async () => {
    setClearingCache(true)
    try {
      const res = await fetch('/api/admin/metadata-cache', { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: "Cache cleared", description: `${data?.count ?? 0} cached provider responses removed. The next sync fetches everything live.` })
        loadCacheStats()
      } else {
        toast({ title: "Couldn't clear the cache", description: data?.error || "Unknown error", variant: "destructive" })
      }
    } finally {
      setClearingCache(false)
    }
  }

  const [isDataLoaded, setIsDataLoaded] = useState(false)
  const [initialStateHash, setInitialStateHash] = useState("")
  const [unsavedModalOpen, setUnsavedModalOpen] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null)

  const currentStateString = JSON.stringify({
      config, configuredLibraries, configuredIndexers, configuredClients,
      configuredHosters, configuredWebhooks, customHeaders, customAcronyms, hosterPriority, searchSourcePriority, scoringRules
  });

  const hasUnsavedChanges = isDataLoaded && initialStateHash !== "" && currentStateString !== initialStateHash;

  const isSourceAvailable = (source: string) => {
    if (source === "COMICVINE") {
      return !!config.cv_api_key && config.cv_api_key.trim() !== "";
    } else if (source === "METRON") {
      return !!config.metron_user && config.metron_user.trim() !== "" && !!config.metron_pass && config.metron_pass.trim() !== "";
    }
    return false;
  };

  useEffect(() => {
    if (isDataLoaded && !isSourceAvailable(config.primary_metadata_source)) {
      if (config.primary_metadata_source === "METRON" && isSourceAvailable("COMICVINE")) {
        setConfig({...config, primary_metadata_source: "COMICVINE"});
      } else if (config.primary_metadata_source === "COMICVINE" && isSourceAvailable("METRON")) {
        setConfig({...config, primary_metadata_source: "METRON", show_popular_issues: "false"});
      }
    }
  }, [config.cv_api_key, config.metron_user, config.metron_pass, isDataLoaded]);

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
                if (item.key !== 'omnibus_api_key' && item.key !== 'hoster_priority' && item.key !== 'release_scoring_rules' && item.key !== 'search_source_priority') {
                    newConfig[item.key] = item.value;
                }
            });

            const scoringSetting = data.settings.find((s: any) => s.key === 'release_scoring_rules');
            if (scoringSetting?.value) {
                try {
                    setScoringRules(JSON.parse(scoringSetting.value));
                } catch(e) {
                    setScoringRules([]);
                }
            } else {
                setScoringRules(DEFAULT_SCORING_RULES.map((r, i) => ({ id: `s${i + 1}`, ...r })));
            }

            const hpSetting = data.settings.find((s: any) => s.key === 'hoster_priority');
            const defaultHosters = [
                { hoster: 'getcomics_direct', enabled: true },
                { hoster: 'getcomics_main', enabled: true },
                { hoster: 'mediafire', enabled: true },
                { hoster: 'mega', enabled: true },
                { hoster: 'pixeldrain', enabled: true },
                { hoster: 'rootz', enabled: false },
                { hoster: 'vikingfile', enabled: false },
                { hoster: 'terabox', enabled: false }
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
                    // Migrate a legacy single `getcomics` entry -> `getcomics_direct` (kept in place) +
                    // `getcomics_main` (inserted right after it, so both stay high-priority). Keeps
                    // existing configs working post-split.
                    const gi = mergedHosters.findIndex(mh => mh.hoster === 'getcomics');
                    if (gi !== -1) {
                        const en = mergedHosters[gi].enabled !== false;
                        mergedHosters[gi] = { hoster: 'getcomics_direct', enabled: en };
                        if (!mergedHosters.some(mh => mh.hoster === 'getcomics_main')) {
                            mergedHosters.splice(gi + 1, 0, { hoster: 'getcomics_main', enabled: en });
                        }
                    }
                    defaultHosters.forEach(dh => {
                        if (!mergedHosters.some(mh => mh.hoster === dh.hoster)) mergedHosters.push(dh);
                    });
                    // Anna's Archive is a search source now, not a hoster mirror — drop any legacy entry
                    // so it no longer shows in the Hoster Priority list (its API key lives in its own section).
                    mergedHosters = mergedHosters.filter((mh: any) => mh.hoster !== 'annas_archive');
                    setHosterPriority(mergedHosters);
                } catch(e) {
                    setHosterPriority(defaultHosters);
                }
            } else {
                setHosterPriority(defaultHosters);
            }

            const sspSetting = data.settings.find((s: any) => s.key === 'search_source_priority');
            const defaultSources = [
                { source: 'getcomics', enabled: true },
                { source: 'annas_archive', enabled: false },
                { source: 'prowlarr', enabled: true }
            ];
            if (sspSetting?.value) {
                try {
                    const saved = JSON.parse(sspSetting.value);
                    let merged: any[] = (saved.length > 0 && typeof saved[0] === 'string')
                        ? saved.map((s: string) => ({ source: s, enabled: true }))
                        : [...saved];
                    // Append any newly-added sources missing from a saved config (disabled by default),
                    // then drop unknown source keys.
                    defaultSources.forEach(ds => {
                        if (!merged.some(ms => ms.source === ds.source)) merged.push({ ...ds, enabled: false });
                    });
                    merged = merged.filter(ms => defaultSources.some(ds => ds.source === ms.source));
                    setSearchSourcePriority(merged);
                } catch (e) {
                    setSearchSourcePriority(defaultSources);
                }
            } else {
                setSearchSourcePriority(defaultSources);
            }
        }

        if (!newConfig.download_retry_delay) newConfig.download_retry_delay = "5";
        if (!newConfig.prowlarr_categories) newConfig.prowlarr_categories = "7030";
        if (newConfig.discord_enabled === undefined) newConfig.discord_enabled = "true";
        if (newConfig.allow_bulk_packs === undefined) newConfig.allow_bulk_packs = "false";
        if (newConfig.prioritize_packs === undefined) newConfig.prioritize_packs = "false";
        if (newConfig.oidc_force_sso === undefined) newConfig.oidc_force_sso = "false";
        if (newConfig.oidc_auto_approve === undefined) newConfig.oidc_auto_approve = "false";
        if (newConfig.ddl_enabled === undefined) newConfig.ddl_enabled = "true";
        
        if (!newConfig.getcomics_interactive_pages) newConfig.getcomics_interactive_pages = "4";
        if (!newConfig.getcomics_automated_pages) newConfig.getcomics_automated_pages = "5";
        if (!newConfig.flaresolverr_timeout) newConfig.flaresolverr_timeout = "300";
        if (!newConfig.solver_type) newConfig.solver_type = "flaresolverr";
        
        if (!newConfig.filter_junk_words) newConfig.filter_junk_words = "preview, sample, ashcan, cropped, scanned, fixed, incomplete, damaged, partial, promo, teaser";
        if (!newConfig.filter_match_ratio) newConfig.filter_match_ratio = "60";
        if (newConfig.filter_exclude_groups === undefined) newConfig.filter_exclude_groups = "";
        
        const predefinedIds = ["7000", "7010", "7020", "7030", "8000"];
        const currentCats = (newConfig.prowlarr_categories).split(',').map((c:string) => c.trim()).filter(Boolean);
        setCustomProwlarrCategories(currentCats.filter((c:string) => !predefinedIds.includes(c)).join(', '));

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
      if (val !== 'access') {
          setGeneratedKey(null);
          setGenerateError(null);
      }
  };

  const handleSave = async () => {
    setLoading(true);

    const payload = { 
        settings: {
            ...config,
            hoster_priority: JSON.stringify(hosterPriority),
            search_source_priority: JSON.stringify(searchSourcePriority),
            release_scoring_rules: JSON.stringify(scoringRules)
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
            const saveData = await res.json().catch(() => ({} as any));
            // The server may have reverted Anna's Archive automation (the API-key + connection-test gate);
            // surface the reason. The toggle re-syncs to the persisted state on the next settings load.
            if (Array.isArray(saveData?.warnings) && saveData.warnings.length > 0) {
                saveData.warnings.forEach((w: string) =>
                    toast({ title: "Heads up", description: w, variant: "destructive" }));
            }
            setInitialStateHash(currentStateString);

            if (activeTab === 'discovery') {
                toast({ title: "Settings Saved", description: "Configuration persisted to database. Rebuilding Discover cache..." })
                fetch('/api/admin/jobs/trigger', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job: 'popular' })
                }).catch(() => {});
            } else {
                toast({ title: "Settings Saved", description: "Configuration persisted to database." })
            }
        }
    } finally { 
        setLoading(false) 
    }
  }

  const updateProwlarrCategories = (toggledId?: string, isChecked?: boolean, newCustom?: string) => {
      const predefinedIds = ["7000", "7010", "7020", "7030", "8000"];
      const current = (config.prowlarr_categories || "").split(',').map((c: string) => c.trim()).filter(Boolean);
      let activePredefined = current.filter((c: string) => predefinedIds.includes(c));
      
      if (toggledId) {
          if (isChecked && !activePredefined.includes(toggledId)) activePredefined.push(toggledId);
          if (!isChecked) activePredefined = activePredefined.filter((c: string) => c !== toggledId);
      }

      const customVal = newCustom !== undefined ? newCustom : customProwlarrCategories;
      if (newCustom !== undefined) {
          setCustomProwlarrCategories(newCustom);
      }

      const customList = customVal.split(',').map((c: string) => c.trim()).filter(Boolean);
      const finalCategories = Array.from(new Set([...activePredefined, ...customList])).join(', ');
      
      setConfig({ ...config, prowlarr_categories: finalCategories });
  };

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

  const toggleProviderEvent = (providerKey: string, eventId: string) => {
    let current = [];
    try { current = JSON.parse(config[`${providerKey}_events`] || "[]"); } catch(e){}
    const updated = current.includes(eventId) ? current.filter((e: string) => e !== eventId) : [...current, eventId];
    setConfig({...config, [`${providerKey}_events`]: JSON.stringify(updated)});
  }

  const addLibrary = () => {
    setConfiguredLibraries([...configuredLibraries, {
        id: `tmp_${Date.now()}`, name: "", path: "", isManga: false, isDefault: configuredLibraries.length === 0, defaultAccess: configuredLibraries.length === 0
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

  const moveSearchSource = (index: number, direction: -1 | 1) => {
      const next = [...searchSourcePriority];
      const tmp = next[index];
      next[index] = next[index + direction];
      next[index + direction] = tmp;
      setSearchSourcePriority(next);
  }

  const toggleSearchSourceEnabled = (index: number) => {
      const next = [...searchSourcePriority];
      next[index] = { ...next[index], enabled: !next[index].enabled };
      setSearchSourcePriority(next);
  }

  // Anna's Archive's premium key is stored as a HosterAccount; managed inline from the AA source section
  // (it's a search source, so it no longer appears in the generic Hoster Accounts list).
  const setAnnasKey = (value: string) => {
      setConfiguredHosters(prev => {
          const idx = prev.findIndex(h => h.hoster === 'annas_archive');
          if (idx >= 0) {
              const next = [...prev];
              next[idx] = { ...next[idx], apiKey: value };
              return next;
          }
          return [...prev, { id: `tmp_${Math.random().toString(36).slice(2, 11)}`, name: "Anna's Archive", hoster: 'annas_archive', username: '', password: '', apiKey: value, isActive: true } as any];
      });
  };

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

  const copyToClipboard = async (text: string) => {
      if (await copyText(text)) toast({ title: "Copied!", description: "API Key copied to clipboard." });
      else toast({ title: "Copy failed", description: "Select the text and copy it manually.", variant: "destructive" });
  }

  // Shared state bag consumed by the tab components (./tabs/*.tsx). Tabs are pure JSX:
  // every piece of state and every handler stays here, so the save pipeline is unchanged.
  const s = {
    config, setConfig, isSourceAvailable, handleTest, testing, testResults, setTestResults,
    cacheStats, clearMetadataCache, clearingCache,
    configuredLibraries, addLibrary, removeLibrary, updateLibrary, setLibraryDefault,
    handleRestoreNamingDefaults, envPaths,
    updateProwlarrCategories, customProwlarrCategories, refreshIndexers, refreshing, hasRefreshed,
    availableIndexers, configuredIndexers, openIndexerModal, deleteIndexer,
    scoringRules, setScoringRules, customAcronyms, setCustomAcronyms,
    configuredClients, openClientSetup, deleteClient, setEditingClient, setClientModalOpen,
    searchSourcePriority, moveSearchSource, toggleSearchSourceEnabled,
    hosterPriority, moveHosterPriority, toggleHosterEnabled,
    configuredHosters, setAnnasKey, openHosterSetup, deleteHoster,
    applyRecommendedFilters, applyForeignFilters,
    configuredWebhooks, openWebhookModal, handleTestWebhook, testingWebhookId,
    toggleWebhookActive, deleteWebhook, toggleProviderEvent,
    users, apiKeys, newKeyName, setNewKeyName, newKeyUserId, setNewKeyUserId,
    newKeyExpiration, setNewKeyExpiration, handleGenerateKey, isGeneratingKey,
    generatedKey, setGeneratedKey, generateError, setGenerateError,
    handleRevokeKey, copyToClipboard,
    customHeaders, addHeader, updateHeader, removeHeader,
    toast,
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
          <TabsTrigger value="library" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Library & Files</TabsTrigger>
          <TabsTrigger value="search" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Search & Indexers</TabsTrigger>
          <TabsTrigger value="downloads" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Downloads</TabsTrigger>
          <TabsTrigger value="discovery" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Discovery & Filtering</TabsTrigger>
          <TabsTrigger value="notifications" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Notifications</TabsTrigger>
          <TabsTrigger value="access" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">Access & Security</TabsTrigger>
          <TabsTrigger value="system" className="px-4 py-2.5 sm:py-2 text-sm sm:text-xs data-[state=active]:bg-background data-[state=active]:text-primary font-bold">System</TabsTrigger>
        </TabsList>

        <TabsContent value="metadata"><MetadataTab s={s} /></TabsContent>
        <TabsContent value="library"><LibraryFilesTab s={s} /></TabsContent>
        <TabsContent value="search" className="space-y-6"><SearchIndexersTab s={s} /></TabsContent>
        <TabsContent value="downloads" className="space-y-6"><DownloadsTab s={s} /></TabsContent>
        <TabsContent value="discovery"><DiscoveryTab s={s} /></TabsContent>
        <TabsContent value="notifications"><NotificationsTab s={s} /></TabsContent>
        <TabsContent value="access" className="space-y-6"><AccessSecurityTab s={s} /></TabsContent>
        <TabsContent value="system" className="space-y-6"><SystemTab s={s} /></TabsContent>

      </Tabs>

      {/* --- MODALS --- */}

      {/* HOSTER MODAL */}
      <Dialog open={hosterModalOpen} onOpenChange={setHosterModalOpen}>
        <DialogContent className="sm:max-w-[425px] w-[95%] bg-background border-border rounded-xl shadow-2xl transition-colors duration-300">
            <DialogHeader><DialogTitle className="text-foreground">Configure {editingHoster?.name}</DialogTitle></DialogHeader>
            {editingHoster && (
                <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                        <Label className="text-foreground font-semibold">API Key (Optional)</Label>
                        <Input type="password" value={editingHoster.apiKey || ""} onChange={e => setEditingHoster({...editingHoster, apiKey: e.target.value})} placeholder="Paste your API key" className="h-12 sm:h-10 bg-muted/20 border-border text-foreground" />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-2">
                        {(editingHoster.hoster === 'pixeldrain' || editingHoster.hoster === 'annas_archive')
                            ? <>An API key authenticates with <strong>{editingHoster.name}</strong> — it bypasses guest bandwidth limits (Pixeldrain) or enables automated downloads (Anna&apos;s Archive member key). Leave blank for anonymous downloads.</>
                            : <><strong>{editingHoster.name}</strong> doesn&apos;t use credentials in Omnibus — downloads are anonymous, so this field has no effect. Only <strong>Pixeldrain</strong> and <strong>Anna&apos;s Archive</strong> currently use an API key.</>}
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
                    type="password" 
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
                        <p className="text-[11px] text-muted-foreground">Comma-separated. The <strong>first</strong> category is used for comics; add a <strong>second</strong> for manga (e.g. <code>comics, manga</code>). Both are tracked in the active-downloads list. <strong className="text-orange-500">Categories/labels MUST exist in your client</strong> (qBittorrent auto-creates them; Deluge needs the Label plugin).</p>
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
                        <StatusBox result={testResults.clients} />
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