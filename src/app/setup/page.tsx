"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/components/ui/use-toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { 
    UserPlus, Database, HardDrive, Download, Search, Settings2, 
    CheckCircle2, Loader2, ArrowRight, ShieldCheck, Play, Plus, Trash2, RefreshCw,
    Webhook, Bell, User, Zap, FolderOpen, UploadCloud, Send, AlertCircle
} from "lucide-react"

const RECOMMENDED_PUBLISHERS = "hakusensha, shueisha, kodansha, shogakukan, square enix, yen press, viz media, seven seas, fakku, project-h, denpa, irodori, eros comix, tokyopop, kadokawa, futabasha, houbunsha, takeshobo, mag garden, akita shoten, shonen gahosha, nihon bungeisha, coamix, gee-whiz, ghost ship, j-novel club, suiseisha, shinchosha, ascii media works, ichijinsha";
const RECOMMENDED_KEYWORDS = "weekly young, young animal, weekly shonen, monthly shonen, gee-whiz, manga, hentai, doujinshi, shoujo, seinen, shojo, josei, gaze, lustiges taschenbuch enten-edition, les tuniques bleues, big comic superior, Creature Girls: A Hands-On Field Journal In Another World, Young King Bull, weekly playboy, big comic spirits, Young Champion Retsu, Big Comic Zōkan, Monthly Young Magazine, Comic Zenon, shonen sunday s, Chira Chiller";

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

export default function SetupWizard() {
  const router = useRouter();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isTesting, setIsTesting] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [testStates, setTestStates] = useState<Record<string, 'idle' | 'success' | 'error'>>({});
  const [adminCreated, setAdminCreated] = useState(false);

  const [formData, setFormData] = useState({
    username: '', email: '', password: '', confirmPassword: '',
    cv_api_key: '',
    download_path: '',
    prowlarr_url: '', prowlarr_key: '', prowlarr_categories: '7030, 8030',
    filter_enabled: false, filter_publishers: '', filter_keywords: '',
    oidc_enabled: false, oidc_issuer: '', oidc_client_id: '', oidc_client_secret: ''
  });

  // Relational States
  const [libraries, setLibraries] = useState<any[]>([{ id: 'tmp_1', name: 'Standard Comics', path: '', isManga: false, isDefault: true }]);
  const [configuredClients, setConfiguredClients] = useState<any[]>([]);
  const [configuredIndexers, setConfiguredIndexers] = useState<any[]>([]);
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [extraUsers, setExtraUsers] = useState<any[]>([]);

  // Local helper states for modals/forms
  const [availableIndexers, setAvailableIndexers] = useState<any[]>([]);
  
  // Download Client Modal States
  const [clientModalOpen, setClientModalOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<any>(null);

  // Indexer Modal States
  const [indexerModalOpen, setIndexerModalOpen] = useState(false);
  const [editingIndexer, setEditingIndexer] = useState<any>({ 
    id: 0, name: "", priority: 25, seedTime: 0, seedRatio: 0, rss: false, protocol: "torrent" 
  });

  // Webhook Modal States
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<any>(null);
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/setup/check')
      .then(res => res.json())
      .then(data => {
        if (!data.requiresSetup) router.push('/login');
        else setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, [router]);

  const updateForm = (key: string, value: any) => {
    setFormData(prev => ({ ...prev, [key]: value }));
    if (testStates[key] !== undefined) {
        setTestStates(prev => ({ ...prev, [key]: 'idle' }));
    }
  };

  const updateEditingClient = (key: string, value: any) => {
      setEditingClient((prev: any) => ({ ...prev, [key]: value }));
      if (testStates['clients'] !== 'idle') {
          setTestStates(prev => ({ ...prev, clients: 'idle' }));
      }
  };

  const getButtonClass = (key: string) => {
      const state = testStates[key];
      if (state === 'success') return "bg-green-600 hover:bg-green-700 text-white border-0";
      if (state === 'error') return "bg-red-600 hover:bg-red-700 text-white border-0";
      return "bg-slate-100 hover:bg-slate-200 text-slate-900 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-white"; 
  };

  const handleRestoreUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsRestoring(true);
      toast({ title: "Restoring Database", description: "Decrypting and merging backup. Please wait..." });

      const uploadFormData = new FormData();
      uploadFormData.append('file', file);

      try {
          const res = await fetch('/api/admin/restore', {
              method: 'POST',
              body: uploadFormData
          });

          const data = await res.json();

          if (res.ok) {
              toast({ title: "Restore Complete", description: "Your server has been fully configured from backup!" });
              router.push('/login');
          } else {
              throw new Error(data.error || "Failed to restore");
          }
      } catch (error: any) {
          toast({ 
              title: "Restore Failed", 
              description: error.message || "Ensure your NEXTAUTH_SECRET matches the original server.", 
              variant: "destructive" 
          });
      } finally {
          setIsRestoring(false);
          if (fileInputRef.current) fileInputRef.current.value = ''; 
      }
  };

  const handleTestConnection = async (type: string, payload: any, stateKey: string) => {
      setIsTesting(stateKey);
      try {
          const res = await fetch('/api/admin/test', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, config: payload })
          });
          const data = await res.json();
          
          if (data.success) {
              setTestStates(prev => ({ ...prev, [stateKey]: 'success' }));
              toast({ title: "Connection Successful!", description: data.message });
              
              if (type === 'comicvine') {
                  await fetch('/api/admin/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ settings: { cv_api_key: payload.cv_api_key } })
                  });
                  
                  fetch('/api/admin/jobs/trigger', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ job: 'popular' })
                  }).catch(() => {});
              }
              return true;
          } else {
              setTestStates(prev => ({ ...prev, [stateKey]: 'error' }));
              toast({ title: "Connection Failed", description: data.message, variant: "destructive" });
              return false;
          }
      } catch (e) {
          setTestStates(prev => ({ ...prev, [stateKey]: 'error' }));
          toast({ title: "Error", description: "Network error occurred.", variant: "destructive" });
          return false;
      } finally { setIsTesting(null); }
  };

  const openClientSetup = (type: string) => {
      const protocols: Record<string, 'Torrent' | 'Usenet'> = { qbit: 'Torrent', deluge: 'Torrent', sab: 'Usenet', nzbget: 'Usenet' };
      const names: Record<string, string> = { qbit: 'qBittorrent', deluge: 'Deluge', sab: 'SABnzbd', nzbget: 'NZBGet' };
      setTestStates(prev => ({ ...prev, clients: 'idle' }));
      setEditingClient({
          id: `tmp_${Math.random().toString(36).substr(2, 9)}`,
          type, name: names[type], protocol: protocols[type],
          url: "", user: "", pass: "", apiKey: "", category: "comics",
          remotePath: "", localPath: ""
      });
      setClientModalOpen(true);
  };

  const saveClientInState = () => {
      if (!editingClient) return;
      setConfiguredClients(prev => {
          const filtered = prev.filter(c => c.id !== editingClient.id);
          return [...filtered, editingClient];
      });
      setClientModalOpen(false);
      toast({ title: "Client Saved" });
  };

  const deleteClient = (id: string) => {
      setConfiguredClients(prev => prev.filter(c => c.id !== id));
      toast({ title: "Client Removed" });
  };

  const handleFetchIndexers = async () => {
      const success = await handleTestConnection('prowlarr', { prowlarr_url: formData.prowlarr_url, prowlarr_key: formData.prowlarr_key }, 'pr');
      if (success) {
          try {
              const res = await fetch('/api/admin/prowlarr/indexers', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url: formData.prowlarr_url, apiKey: formData.prowlarr_key, headers: [] })
              });
              const data = await res.json();
              if (Array.isArray(data)) setAvailableIndexers(data);
          } catch(e) { }
      }
  };

  const openIndexerModal = (indexer: any, isEdit = false) => {
    const protocol = indexer.protocol || "torrent";
    if (isEdit) {
        setEditingIndexer({ ...indexer, seedRatio: indexer.seedRatio || 0 });
    } else {
        setEditingIndexer({
            id: indexer.id, name: indexer.name, priority: 25, seedTime: 0, seedRatio: 0, rss: true, protocol
        });
    }
    setIndexerModalOpen(true);
  };

  const saveIndexerConfig = () => {
    setConfiguredIndexers(prev => {
        const filtered = prev.filter(i => i.id !== editingIndexer.id);
        return [...filtered, editingIndexer];
    });
    setIndexerModalOpen(false);
    toast({ title: "Indexer Saved" });
  };

  const deleteIndexer = (id: number) => {
    setConfiguredIndexers(prev => prev.filter(i => i.id !== id));
    toast({ title: "Indexer Removed" });
  };

  const openWebhookModal = (webhook?: any) => {
    if (webhook) {
      setEditingWebhook({ ...webhook });
    } else {
      setEditingWebhook({
        id: `tmp_${Math.random().toString(36).substr(2, 9)}`,
        name: "", url: "", events: [], isActive: true,
        botUsername: "", botAvatarUrl: "" 
      });
    }
    setWebhookModalOpen(true);
  };

  const saveWebhook = () => {
    if (!editingWebhook?.name || !editingWebhook?.url) {
      toast({ title: "Validation Error", description: "Name and URL are required.", variant: "destructive" });
      return;
    }
    setWebhooks(prev => {
      const filtered = prev.filter(w => w.id !== editingWebhook.id);
      return [...filtered, editingWebhook];
    });
    setWebhookModalOpen(false);
    toast({ title: "Webhook Configured" });
  };

  const deleteWebhook = (id: string) => {
    setWebhooks(prev => prev.filter(w => w.id !== id));
    toast({ title: "Webhook Removed" });
  };

  const toggleWebhookActive = (id: string) => {
    setWebhooks(prev => prev.map(w => w.id === id ? { ...w, isActive: !w.isActive } : w));
  };

  const toggleWebhookEvent = (eventId: string) => {
    if (!editingWebhook) return;
    const hasEvent = editingWebhook.events.includes(eventId);
    setEditingWebhook({
      ...editingWebhook,
      events: hasEvent 
        ? editingWebhook.events.filter((e: string) => e !== eventId) 
        : [...editingWebhook.events, eventId]
    });
  };

  const handleTestWebhook = async (webhook: any) => {
    setTestingWebhookId(webhook.id);
    try {
      const res = await fetch('/api/admin/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'webhook', config: webhook })
      });
      const data = await res.json();
      if (data.success) {
        toast({ title: "Test Sent", description: "Check your Discord channel." });
      } else {
        toast({ title: "Test Failed", description: data.error || data.message || "Failed to reach Discord.", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "Error", description: "System communication error.", variant: "destructive" });
    } finally {
      setTestingWebhookId(null);
    }
  };

  const handleNext = async () => {
      if (step === 1 && !adminCreated) {
          if (!formData.username || !formData.email || !formData.password) return toast({ title: "Missing Fields", variant: "destructive" });
          if (formData.password !== formData.confirmPassword) return toast({ title: "Password Mismatch", variant: "destructive" });
          
          setIsTesting('admin');
          const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: formData.username, email: formData.email, password: formData.password }) });
          const data = await res.json();
          setIsTesting(null);

          if (data.success) {
              setAdminCreated(true);
              toast({ title: "Admin Created" });
              setStep(2);
          } else {
              return toast({ title: "Error", description: data.error, variant: "destructive" });
          }
          return;
      }
      setStep(prev => prev + 1);
  };

  const handleFinish = async () => {
      setIsTesting('finish');
      
      const finalPayload = {
          settings: {
              cv_api_key: formData.cv_api_key,
              download_path: formData.download_path,
              prowlarr_url: formData.prowlarr_url,
              prowlarr_key: formData.prowlarr_key,
              prowlarr_categories: formData.prowlarr_categories,
              filter_enabled: formData.filter_enabled ? "true" : "false",
              filter_publishers: formData.filter_publishers,
              filter_keywords: formData.filter_keywords,
              oidc_enabled: formData.oidc_enabled ? "true" : "false",
              oidc_issuer: formData.oidc_issuer,
              oidc_client_id: formData.oidc_client_id,
              oidc_client_secret: formData.oidc_client_secret,
              setup_complete: 'true' 
          },
          libraries,
          downloadClients: configuredClients,
          indexers: configuredIndexers,
          discordWebhooks: webhooks
      };

      try {
          const res = await fetch('/api/admin/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(finalPayload)
          });
          
          if (res.ok) {
              for (const u of extraUsers) {
                  await fetch('/api/auth/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(u)
                  }).catch(() => {});
              }

              fetch('/api/admin/jobs/trigger', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ job: 'library' })
              }).catch(() => {});

              toast({ title: "Setup Complete!", description: "Welcome to Omnibus." });
              router.push('/login'); 
          } else {
              toast({ title: "Save Failed", variant: "destructive" });
          }
      } catch (e) {
          toast({ title: "Error", variant: "destructive" });
      } finally {
          setIsTesting(null);
      }
  };

  if (isLoading) return <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div>;

  const steps = [
      { id: 1, title: "Admin", icon: UserPlus },
      { id: 2, title: "Metadata", icon: Database },
      { id: 3, title: "Storage", icon: HardDrive },
      { id: 4, title: "Clients", icon: Download },
      { id: 5, title: "Indexers", icon: Search },
      { id: 6, title: "Discord", icon: Webhook },
      { id: 7, title: "Users", icon: User },
      { id: 8, title: "Finalize", icon: Settings2 },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
      <title>Omnibus - Initial Setup</title>
      
      <div className="max-w-4xl w-full space-y-8">
        <div className="text-center space-y-2">
            <h1 className="text-4xl font-black tracking-tight text-slate-900 dark:text-white">Welcome to Omnibus.</h1>
            <p className="text-muted-foreground text-lg">Let's get your library configured and ready to read.</p>
        </div>

        <div className="flex items-center justify-between relative px-4">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-slate-200 dark:bg-slate-800 -z-10 rounded-full">
                <div className="h-full bg-blue-500 transition-all duration-500 rounded-full" style={{ width: `${((step - 1) / 7) * 100}%` }} />
            </div>
            {steps.map(s => {
                const Icon = s.icon;
                const isActive = step === s.id;
                const isPast = step > s.id;
                return (
                    <div key={s.id} className="flex flex-col items-center gap-2 bg-slate-50 dark:bg-slate-950 px-2 hidden sm:flex">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors ${isActive ? 'border-blue-500 bg-blue-500 text-white shadow-lg shadow-blue-500/20' : isPast ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-500' : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-400'}`}>
                            {isPast ? <CheckCircle2 className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
                        </div>
                        <span className={`text-[10px] font-bold ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}>{s.title}</span>
                    </div>
                )
            })}
            
            {/* Mobile Step Indicator */}
            <div className="sm:hidden flex w-full justify-center">
                <span className="bg-blue-500 text-white px-4 py-1 rounded-full text-xs font-bold shadow-md">
                    Step {step} of 8
                </span>
            </div>
        </div>

        <Card className="p-4 sm:p-8 shadow-xl dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-2xl relative overflow-hidden">
            
            {/* STEP 1: ADMIN & RESTORE */}
            {step === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                            <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><ShieldCheck className="text-blue-500"/> Master Account</h2>
                            <p className="text-muted-foreground mt-1 text-sm">Create your admin account to begin manual setup.</p>
                        </div>
                        
                        <div className="shrink-0">
                            <input type="file" accept=".json" ref={fileInputRef} className="hidden" onChange={handleRestoreUpload} />
                            <Button 
                                variant="outline" 
                                className="w-full sm:w-auto font-bold border-blue-200 text-blue-600 bg-blue-50 hover:bg-blue-100 dark:border-blue-900/50 dark:text-blue-400 dark:bg-blue-900/20 dark:hover:bg-blue-900/40"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isRestoring}
                            >
                                {isRestoring ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2" />}
                                Restore from Backup
                            </Button>
                        </div>
                    </div>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-200 dark:border-slate-800" /></div>
                        <div className="relative flex justify-center text-xs uppercase"><span className="bg-white dark:bg-slate-900 px-2 text-muted-foreground">Or setup manually</span></div>
                    </div>

                    <div className="space-y-4">
                        <div className="grid gap-2"><Label>Username</Label><Input value={formData.username} onChange={e => updateForm('username', e.target.value)} disabled={adminCreated} className="h-12 bg-white dark:bg-slate-950"/></div>
                        <div className="grid gap-2"><Label>Email Address</Label><Input type="email" value={formData.email} onChange={e => updateForm('email', e.target.value)} disabled={adminCreated} className="h-12 bg-white dark:bg-slate-950"/></div>
                        <div className="grid sm:grid-cols-2 gap-4">
                            <div className="grid gap-2"><Label>Password</Label><Input type="password" value={formData.password} onChange={e => updateForm('password', e.target.value)} disabled={adminCreated} className="h-12 bg-white dark:bg-slate-950"/></div>
                            <div className="grid gap-2"><Label>Confirm Password</Label><Input type="password" value={formData.confirmPassword} onChange={e => updateForm('confirmPassword', e.target.value)} disabled={adminCreated} className="h-12 bg-white dark:bg-slate-950"/></div>
                        </div>
                    </div>
                </div>
            )}

            {/* STEP 2: COMICVINE */}
            {step === 2 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><Database className="w-6 h-6 text-green-500"/> Metadata Source</h2>
                        <p className="text-muted-foreground mt-1">Omnibus uses ComicVine to automatically pull covers, synopses, and creator credits.</p>
                    </div>
                    <div className="space-y-4 bg-slate-50 dark:bg-slate-950 p-6 rounded-xl border dark:border-slate-800">
                        <div className="grid gap-2">
                            <Label>API Key <span className="text-red-500">*</span></Label>
                            <Input value={formData.cv_api_key} onChange={e => updateForm('cv_api_key', e.target.value)} placeholder="Enter your ComicVine Key..." className="h-12 bg-white dark:bg-slate-900"/>
                            <p className="text-xs text-muted-foreground mt-1">Don't have one? Get it for free at <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">comicvine.gamespot.com/api</a>.</p>
                        </div>
                        <Button className={`w-full h-12 font-bold mt-2 transition-colors ${getButtonClass('cv')}`} disabled={!formData.cv_api_key || isTesting === 'cv'} onClick={() => handleTestConnection('comicvine', { cv_api_key: formData.cv_api_key }, 'cv')}>
                            {isTesting === 'cv' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : testStates['cv'] === 'success' ? <CheckCircle2 className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" />} 
                            {testStates['cv'] === 'success' ? "Tested & Saved (Syncing Discover...)" : "Test & Save Connection"}
                        </Button>
                    </div>
                </div>
            )}

            {/* STEP 3: MULTI-LIBRARY STORAGE */}
            {step === 3 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><HardDrive className="w-6 h-6 text-purple-500"/> Storage Mappings</h2>
                        <p className="text-muted-foreground mt-1">Tell Omnibus where to store and organize your physical files.</p>
                    </div>
                    <div className="space-y-5">
                        <div className="grid gap-2">
                            <Label>Download Scan Root</Label>
                            <Input value={formData.download_path} onChange={e => updateForm('download_path', e.target.value)} placeholder="e.g. /downloads" className="h-12 bg-white dark:bg-slate-950"/>
                            <p className="text-[10px] text-muted-foreground">The folder where your download clients save completed files.</p>
                        </div>

                        <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                            <Label className="uppercase text-xs text-muted-foreground tracking-widest font-bold mb-3 block">Library Folders</Label>
                            <div className="space-y-3">
                                {libraries.map((lib, i) => (
                                    <div key={lib.id} className="p-4 border rounded-lg bg-slate-50 dark:bg-slate-950/50 relative">
                                        <div className="grid sm:grid-cols-2 gap-4">
                                            <Input placeholder="Name (e.g. Standard Comics)" value={lib.name} onChange={e => {
                                                const nl = [...libraries]; nl[i].name = e.target.value; setLibraries(nl);
                                            }} className="bg-white dark:bg-slate-900" />
                                            <Input placeholder="Path (e.g. /data/comics)" value={lib.path} onChange={e => {
                                                const nl = [...libraries]; nl[i].path = e.target.value; setLibraries(nl);
                                            }} className="bg-white dark:bg-slate-900 font-mono" />
                                        </div>
                                        <div className="flex items-center gap-6 mt-3">
                                            <div className="flex items-center gap-2">
                                                <Switch checked={lib.isManga} onCheckedChange={v => {
                                                    const nl = [...libraries]; nl[i].isManga = v; setLibraries(nl);
                                                }}/>
                                                <Label className="text-xs">Manga Destination</Label>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Switch checked={lib.isDefault} onCheckedChange={v => {
                                                    const nl = libraries.map(l => {
                                                        if (l.isManga === lib.isManga) return { ...l, isDefault: l.id === lib.id };
                                                        return l;
                                                    }); 
                                                    setLibraries(nl);
                                                }}/>
                                                <Label className="text-xs">Default for Auto-Import</Label>
                                            </div>
                                        </div>
                                        {libraries.length > 1 && (
                                            <Button variant="ghost" size="icon" className="absolute top-2 right-2 text-red-500" onClick={() => setLibraries(libraries.filter(l => l.id !== lib.id))}>
                                                <Trash2 className="w-4 h-4"/>
                                            </Button>
                                        )}
                                    </div>
                                ))}
                                <Button variant="outline" className="w-full border-dashed" onClick={() => setLibraries([...libraries, { id: `tmp_${Date.now()}`, name: '', path: '', isManga: false, isDefault: false }])}>
                                    <Plus className="w-4 h-4 mr-2"/> Add Another Library
                                </Button>
                            </div>
                        </div>

                        <Button className={`w-full h-12 font-bold mt-2 transition-colors ${getButtonClass('paths')}`} onClick={() => handleTestConnection('paths', {}, 'paths')} disabled={isTesting === 'paths'}>
                            {isTesting === 'paths' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : testStates['paths'] === 'success' ? <CheckCircle2 className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" />} 
                            {testStates['paths'] === 'success' ? "Paths Verified!" : "Test Paths"}
                        </Button>
                    </div>
                </div>
            )}

            {/* STEP 4: DOWNLOAD CLIENTS */}
            {step === 4 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><Download className="w-6 h-6 text-blue-500"/> Download Clients</h2>
                        <p className="text-muted-foreground mt-1">Connect your torrent or usenet clients so Omnibus can send them downloads.</p>
                    </div>

                    {configuredClients.length > 0 && (
                        <div className="grid gap-2 p-4 border dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900/50">
                            <Label className="uppercase text-xs text-muted-foreground tracking-widest font-bold">Added Clients</Label>
                            {configuredClients.map((c, i) => (
                                <div key={i} className="flex justify-between items-center bg-white dark:bg-slate-950 p-3 rounded-lg shadow-sm border dark:border-slate-800">
                                    <div><p className="font-bold text-sm">{c.name}</p><p className="text-[10px] text-muted-foreground">{c.url}</p></div>
                                    <div className="flex gap-1 shrink-0">
                                        <Button variant="ghost" size="icon" onClick={() => { setEditingClient(c); setTestStates(prev => ({ ...prev, clients: 'idle' })); setClientModalOpen(true); }}><Settings2 className="w-4 h-4"/></Button>
                                        <Button variant="ghost" size="icon" onClick={() => deleteClient(c.id)}><Trash2 className="w-4 h-4 text-red-500"/></Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="space-y-4 pt-2">
                        <Label className="uppercase text-xs text-muted-foreground tracking-widest font-bold">Add New Client</Label>
                        <div className="grid grid-cols-2 gap-4 mb-4">
                            {['qbit', 'sab', 'deluge', 'nzbget'].map(type => (
                                <Button key={type} variant="outline" className="h-12 font-bold" onClick={() => openClientSetup(type)}>
                                    {configuredClients.some(c => c.type === type) && <CheckCircle2 className="w-4 h-4 text-green-400 mr-2"/>}
                                    {type.toUpperCase()}
                                </Button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* STEP 5: INDEXERS */}
            {step === 5 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><Search className="w-6 h-6 text-orange-500"/> Connect Prowlarr</h2>
                        <p className="text-muted-foreground mt-1">Omnibus uses Prowlarr to search across all your indexers simultaneously.</p>
                    </div>
                    <div className="space-y-4">
                        <div className="grid gap-2">
                            <Label>Prowlarr URL</Label>
                            <Input value={formData.prowlarr_url} onChange={e => updateForm('prowlarr_url', e.target.value)} placeholder="http://192.168.1.100:9696" className="h-12 bg-white dark:bg-slate-950"/>
                        </div>
                        <div className="grid gap-2">
                            <Label>API Key</Label>
                            <Input value={formData.prowlarr_key} onChange={e => updateForm('prowlarr_key', e.target.value)} className="h-12 bg-white dark:bg-slate-950"/>
                        </div>
                        <div className="grid gap-2">
                            <Label>Search Categories (Torznab IDs)</Label>
                            <Input value={formData.prowlarr_categories} onChange={(e) => updateForm('prowlarr_categories', e.target.value)} placeholder="e.g. 7030, 8030" className="h-12 bg-white dark:bg-slate-950"/>
                            <p className="text-xs text-muted-foreground mt-1">Standard categories: <strong>7030</strong> (Comics), <strong>8030</strong> (Manga). Use a comma-separated list.</p>
                        </div>
                        <Button className={`w-full h-12 font-bold mt-4 transition-colors ${getButtonClass('pr')}`} disabled={!formData.prowlarr_url || !formData.prowlarr_key || isTesting === 'pr'} onClick={handleFetchIndexers}>
                            {isTesting === 'pr' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />} 
                            {testStates['pr'] === 'success' ? "Refresh Indexers" : "Connect & Fetch Indexers"}
                        </Button>

                        {availableIndexers.length > 0 && (
                            <div className="mt-4 border dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900/50 p-4">
                                <Label className="uppercase text-xs text-muted-foreground tracking-widest font-bold mb-3 block">Select Indexers to Use</Label>
                                <div className="grid gap-2 max-h-[200px] overflow-y-auto pr-2">
                                    {availableIndexers.map(idx => (
                                        <div key={idx.id} className="flex justify-between items-center p-3 bg-white dark:bg-slate-950 border dark:border-slate-800 rounded-lg shadow-sm">
                                            <div>
                                                <span className="font-bold text-sm block text-foreground">{idx.name}</span>
                                                <span className="text-[10px] text-muted-foreground uppercase">{idx.protocol}</span>
                                            </div>
                                            {configuredIndexers.some(c => c.id === idx.id) ? (
                                                <Badge className="bg-green-500 hover:bg-green-600">Added</Badge>
                                            ) : (
                                                <Button size="sm" variant="outline" onClick={() => openIndexerModal(idx)}><Plus className="w-3 h-3 mr-1"/> Add</Button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {configuredIndexers.length > 0 && (
                            <div className="pt-4 border-t dark:border-slate-800">
                                <Label className="uppercase text-xs text-muted-foreground tracking-widest font-bold mb-3 block">Configured Indexers</Label>
                                <div className="grid sm:grid-cols-2 gap-4">
                                    {configuredIndexers.map(idx => (
                                        <Card key={idx.id} className="p-4 shadow-sm dark:bg-slate-900 border-slate-200 dark:border-slate-800">
                                            <div className="flex justify-between items-start mb-2">
                                                <div className="min-w-0 flex-1 pr-2">
                                                    <p className="font-bold text-sm truncate text-foreground">{idx.name}</p>
                                                    <Badge variant="secondary" className="text-[9px] uppercase tracking-wider mt-1">{idx.protocol || "torrent"}</Badge>
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openIndexerModal(idx, true)}><Settings2 className="h-4 w-4"/></Button>
                                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500" onClick={() => deleteIndexer(idx.id)}><Trash2 className="h-4 w-4"/></Button>
                                                </div>
                                            </div>
                                            <div className="text-[10px] text-muted-foreground border-t dark:border-slate-800 pt-2 uppercase tracking-tight">Priority: {idx.priority} • RSS: {idx.rss ? "Enabled" : "Disabled"}</div>
                                        </Card>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* STEP 6: DISCORD */}
            {step === 6 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><Webhook className="w-6 h-6 text-indigo-500"/> Discord Alerts (Optional)</h2>
                        <p className="text-muted-foreground mt-1">Automatically send notifications to your server when new comics are added or requested.</p>
                    </div>

                    <div className="space-y-4 pt-2">
                        <Button variant="outline" className="w-full h-12 font-bold border-dashed border-2" onClick={() => openWebhookModal()}>
                            <Plus className="w-4 h-4 mr-2" /> Add Webhook
                        </Button>
                        
                        {webhooks.length > 0 && (
                            <div className="grid gap-4 mt-4">
                                {webhooks.map(hook => (
                                    <div key={hook.id} className="flex flex-col border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50 dark:bg-slate-900/50 shadow-sm p-4 gap-3">
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                            <div className="flex flex-col gap-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-bold text-lg sm:text-base text-foreground">{hook.name}</span>
                                                    <Badge variant={hook.isActive ? "secondary" : "outline"} className={hook.isActive ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0" : "text-muted-foreground"}>
                                                        {hook.isActive ? "Active" : "Disabled"}
                                                    </Badge>
                                                </div>
                                                <p className="text-xs sm:text-[11px] font-mono text-muted-foreground truncate max-w-[300px] sm:max-w-md">
                                                    {hook.url.replace(/https:\/\/discord\.com\/api\/webhooks\/[^\/]+\//, "https://.../")}
                                                </p>
                                            </div>
                                            
                                            <div className="flex items-center gap-2 shrink-0 border-t sm:border-0 border-slate-200 dark:border-slate-800 pt-3 sm:pt-0">
                                                <Button 
                                                    variant="outline" 
                                                    size="icon" 
                                                    className="h-10 w-10 sm:h-8 sm:w-8 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20" 
                                                    disabled={testingWebhookId === hook.id}
                                                    onClick={() => handleTestWebhook(hook)}
                                                >
                                                    {testingWebhookId === hook.id ? <Loader2 className="h-5 w-5 sm:h-4 sm:w-4 animate-spin" /> : <Send className="h-5 w-5 sm:h-4 sm:w-4" />}
                                                </Button>
                                                <Switch checked={hook.isActive} onCheckedChange={() => toggleWebhookActive(hook.id)} className="mx-2 scale-110 sm:scale-100" />
                                                <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:bg-slate-200 dark:hover:bg-slate-800 text-foreground" onClick={() => openWebhookModal(hook)}>
                                                    <Settings2 className="h-5 w-5 sm:h-4 sm:w-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => deleteWebhook(hook.id)}>
                                                    <Trash2 className="h-5 w-5 sm:h-4 sm:w-4" />
                                                </Button>
                                            </div>
                                        </div>
                                        
                                        <div className="flex flex-wrap gap-1.5 bg-white dark:bg-slate-950 p-2 rounded-md border border-slate-200 dark:border-slate-800">
                                            {hook.events.map((ev: string) => (
                                                <Badge key={ev} variant="outline" className="text-[10px] uppercase tracking-tighter text-muted-foreground border-slate-200 dark:border-slate-800">
                                                    {ev.replace(/_/g, ' ')}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* STEP 7: EXTRA USERS */}
            {step === 7 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><User className="w-6 h-6 text-pink-500"/> Add Users (Optional)</h2>
                        <p className="text-muted-foreground mt-1">Create accounts for family or friends before you launch.</p>
                    </div>
                    
                    {extraUsers.length > 0 && (
                        <div className="grid gap-2 p-4 border dark:border-slate-800 rounded-xl bg-slate-50 dark:bg-slate-900/50">
                            <Label className="uppercase text-xs text-muted-foreground tracking-widest font-bold">Staged Users</Label>
                            {extraUsers.map((u, i) => (
                                <div key={i} className="flex justify-between items-center bg-white dark:bg-slate-950 p-3 rounded-lg shadow-sm border dark:border-slate-800">
                                    <div>
                                        <p className="font-bold text-sm text-foreground">{u.username}</p>
                                        <div className="flex gap-2 mt-1">
                                            {u.canDownload && <Badge variant="outline" className="text-[9px]">Downloader</Badge>}
                                            {u.autoApproveRequests && <Badge variant="outline" className="text-[9px]">Auto-Approve</Badge>}
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="icon" onClick={() => setExtraUsers(prev => prev.filter((_, idx) => idx !== i))}><Trash2 className="w-4 h-4 text-red-500"/></Button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="space-y-4 border dark:border-slate-800 p-6 rounded-xl bg-slate-50 dark:bg-slate-950">
                        <Input placeholder="Username" id="u-name" className="h-12 bg-white dark:bg-slate-900"/>
                        <Input placeholder="Email" id="u-email" type="email" className="h-12 bg-white dark:bg-slate-900"/>
                        <Input placeholder="Password" id="u-pass" type="password" className="h-12 bg-white dark:bg-slate-900"/>
                        <div className="flex gap-6 py-2">
                            <div className="flex items-center gap-2"><Switch id="u-dl"/><Label className="text-xs cursor-pointer">Can Download</Label></div>
                            <div className="flex items-center gap-2"><Switch id="u-auto"/><Label className="text-xs cursor-pointer">Auto-Approve</Label></div>
                        </div>
                        <Button className="w-full h-12 font-bold" onClick={() => {
                            const n = (document.getElementById('u-name') as HTMLInputElement).value;
                            const e = (document.getElementById('u-email') as HTMLInputElement).value;
                            const p = (document.getElementById('u-pass') as HTMLInputElement).value;
                            const d = (document.getElementById('u-dl') as HTMLButtonElement).dataset.state === 'checked';
                            const a = (document.getElementById('u-auto') as HTMLButtonElement).dataset.state === 'checked';
                            if (n && e && p) {
                                setExtraUsers([...extraUsers, { username: n, email: e, password: p, canDownload: d, autoApproveRequests: a, role: 'USER', isApproved: true }]);
                                (document.getElementById('u-name') as HTMLInputElement).value = "";
                                (document.getElementById('u-email') as HTMLInputElement).value = "";
                                (document.getElementById('u-pass') as HTMLInputElement).value = "";
                                toast({ title: "User Staged" });
                            }
                        }}><UserPlus className="w-4 h-4 mr-2" /> Stage User</Button>
                    </div>
                </div>
            )}

            {/* STEP 8: FINALIZE */}
            {step === 8 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2 text-foreground"><Settings2 className="w-6 h-6 text-teal-500"/> Optional Extras</h2>
                        <p className="text-muted-foreground mt-1">Fine-tune your setup. You can always change these later in Settings.</p>
                    </div>
                    <div className="space-y-6">
                        <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-950 rounded-xl border dark:border-slate-800">
                            <div className="flex items-center justify-between">
                                <div>
                                    <Label className="text-base">Enable Content Filter</Label>
                                    <p className="text-xs text-muted-foreground mt-1">Block specific keywords or publishers from the Discovery page.</p>
                                </div>
                                <Switch checked={formData.filter_enabled} onCheckedChange={v => updateForm('filter_enabled', v)} />
                            </div>
                            {formData.filter_enabled && (
                                <div className="pt-2 border-t dark:border-slate-800 space-y-4">
                                    <Button 
                                        variant="secondary" 
                                        className="w-full font-bold"
                                        onClick={() => {
                                            updateForm('filter_publishers', RECOMMENDED_PUBLISHERS);
                                            updateForm('filter_keywords', RECOMMENDED_KEYWORDS);
                                        }}
                                    >
                                        Load NSFW Defaults
                                    </Button>
                                    <div className="grid gap-2"><Label>Blocked Publishers</Label><Input value={formData.filter_publishers} onChange={e => updateForm('filter_publishers', e.target.value)} className="bg-white dark:bg-slate-900" /></div>
                                    <div className="grid gap-2"><Label>Blocked Keywords</Label><Input value={formData.filter_keywords} onChange={e => updateForm('filter_keywords', e.target.value)} className="bg-white dark:bg-slate-900" /></div>
                                </div>
                            )}
                        </div>
                        
                        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-950 rounded-xl border dark:border-slate-800">
                            <div>
                                <Label className="text-base">Enable SSO (OpenID Connect)</Label>
                                <p className="text-xs text-muted-foreground mt-1">Allow users to log in using Authentik, Authelia, or Google.</p>
                            </div>
                            <Switch checked={formData.oidc_enabled} onCheckedChange={v => updateForm('oidc_enabled', v)} />
                        </div>

                        {formData.oidc_enabled && (
                            <div className="grid gap-4 p-4 border dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-950/50">
                                <div className="grid gap-2"><Label>Issuer URL</Label><Input value={formData.oidc_issuer} onChange={e => updateForm('oidc_issuer', e.target.value)} className="bg-white dark:bg-slate-900" /></div>
                                <div className="grid sm:grid-cols-2 gap-4">
                                    <div className="grid gap-2"><Label>Client ID</Label><Input value={formData.oidc_client_id} onChange={e => updateForm('oidc_client_id', e.target.value)} className="bg-white dark:bg-slate-900" /></div>
                                    <div className="grid gap-2"><Label>Client Secret</Label><Input type="password" value={formData.oidc_client_secret} onChange={e => updateForm('oidc_client_secret', e.target.value)} className="bg-white dark:bg-slate-900" /></div>
                                </div>
                            </div>
                        )}

                        <div className="text-center pt-6 space-y-4">
                            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto" />
                            <h2 className="text-2xl font-bold text-foreground">Ready to Launch!</h2>
                            <p className="text-muted-foreground">We've staged your admin account, {libraries.length} libraries, and {configuredClients.length} clients.</p>
                        </div>
                    </div>
                </div>
            )}

            <div className="mt-10 pt-6 border-t dark:border-slate-800 flex justify-between">
                <Button variant="ghost" disabled={step === 1 || isTesting === 'admin'} onClick={() => setStep(s => s - 1)}>Back</Button>
                
                {step < 8 ? (
                    <Button onClick={handleNext} disabled={isTesting === 'admin'} className="bg-blue-600 hover:bg-blue-700 text-white w-32 font-bold">
                        {isTesting === 'admin' ? <Loader2 className="w-5 h-5 animate-spin" /> : "Next Step"} <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                ) : (
                    <Button onClick={handleFinish} disabled={isTesting === 'finish'} className="bg-green-600 hover:bg-green-700 text-white w-40 sm:w-48 font-bold text-base sm:text-lg h-12 shadow-lg shadow-green-500/20">
                        {isTesting === 'finish' ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Play className="w-5 h-5 mr-2" />} Finish Setup
                    </Button>
                )}
            </div>
        </Card>
      </div>

      {/* DOWNLOAD CLIENT MODAL */}
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
                              <FolderOpen className="w-4 h-4 text-blue-500" />
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
                          <Button className={`w-full h-12 sm:h-10 font-bold transition-colors ${getButtonClass('clients')}`} onClick={() => handleTestConnection('clients', { clientType: editingClient.type, ...editingClient }, 'clients')} disabled={isTesting === 'clients' || !editingClient.url}>
                              {isTesting === 'clients' ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2"/> : testStates['clients'] === 'success' ? <CheckCircle2 className="w-5 h-5 sm:w-4 sm:h-4 mr-2"/> : <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2"/>} 
                              {testStates['clients'] === 'success' ? "Connection Verified!" : "Test Connection"}
                          </Button>
                      </div>
                  </div>
              )}
              <DialogFooter className="gap-2 sm:gap-0">
                  <Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setClientModalOpen(false)}>Cancel</Button>
                  <Button className="h-12 sm:h-10 font-bold bg-blue-600 hover:bg-blue-700 text-white shadow-md" onClick={saveClientInState}>Save Settings</Button>
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
                    <Switch id="rss" checked={editingIndexer.rss} onCheckedChange={c => setEditingIndexer({...editingIndexer, rss: !!c})} className="scale-110 sm:scale-100" />
                    <Label htmlFor="rss" className="cursor-pointer font-bold ml-2 text-foreground group-hover:text-primary transition-colors">Enable RSS Monitoring</Label>
                </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="ghost" className="h-12 sm:h-10 hover:bg-muted text-foreground" onClick={() => setIndexerModalOpen(false)}>Cancel</Button>
                <Button className="h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md" onClick={saveIndexerConfig}>Save Settings</Button>
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

    </div>
  )
}