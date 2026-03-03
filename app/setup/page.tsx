"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
    UserPlus, Database, HardDrive, Download, Search, Settings2, 
    CheckCircle2, ChevronRight, Loader2, ArrowRight, ShieldCheck, Play
} from "lucide-react"

export default function SetupWizard() {
  const router = useRouter();
  const { toast } = useToast();
  
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isTesting, setIsTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});
  const [adminCreated, setAdminCreated] = useState(false);

  const [formData, setFormData] = useState({
    // Step 1: Admin
    username: '', email: '', password: '', confirmPassword: '',
    // Step 2: Metadata
    cv_api_key: '',
    // Step 3: Storage
    library_path: '', manga_library_path: '',
    // Step 4: Downloader
    clientType: 'qbit', clientUrl: '', clientUser: '', clientPass: '', clientApiKey: '',
    // Step 5: Indexers
    prowlarr_url: '', prowlarr_key: '',
    // Step 6: Extras
    filter_enabled: false, filter_publishers: '',
    oidc_enabled: false, oidc_issuer: '', oidc_client_id: '', oidc_client_secret: ''
  });

  // Verify if setup is actually needed
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
    // Reset test result if they change the setting
    if (testResults[key] !== undefined) {
        setTestResults(prev => ({ ...prev, [key]: false }));
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
              setTestResults(prev => ({ ...prev, [stateKey]: true }));
              toast({ title: "Connection Successful!", description: data.message });
          } else {
              setTestResults(prev => ({ ...prev, [stateKey]: false }));
              toast({ title: "Connection Failed", description: data.message, variant: "destructive" });
          }
      } catch (e) {
          toast({ title: "Error", description: "Network error occurred.", variant: "destructive" });
      } finally {
          setIsTesting(null);
      }
  };

  const handleNext = async () => {
      // Admin Creation Step
      if (step === 1 && !adminCreated) {
          if (!formData.username || !formData.email || !formData.password) {
              return toast({ title: "Missing Fields", description: "Please fill out all admin details.", variant: "destructive" });
          }
          if (formData.password !== formData.confirmPassword) {
              return toast({ title: "Password Mismatch", description: "Passwords do not match.", variant: "destructive" });
          }
          
          setIsTesting('admin');
          const res = await fetch('/api/auth/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: formData.username, email: formData.email, password: formData.password })
          });
          const data = await res.json();
          setIsTesting(null);

          if (data.success) {
              setAdminCreated(true);
              toast({ title: "Admin Created", description: "Account secured. Moving to next step." });
              setStep(2);
          } else {
              return toast({ title: "Error", description: data.error, variant: "destructive" });
          }
          return;
      }

      // Storage Validation
      if (step === 3) {
          if (!formData.library_path.trim()) {
              return toast({ title: "Missing Path", description: "A standard Comic library path is required.", variant: "destructive" });
          }
      }

      setStep(prev => prev + 1);
  };

  const handleFinish = async () => {
      setIsTesting('finish');
      
      const finalConfig = {
          cv_api_key: formData.cv_api_key,
          library_path: formData.library_path,
          manga_library_path: formData.manga_library_path,
          // Build Downloader Array automatically
          download_clients_config: JSON.stringify([{
              name: "Primary",
              type: formData.clientType,
              url: formData.clientUrl,
              user: formData.clientUser,
              pass: formData.clientPass,
              apiKey: formData.clientApiKey,
              category: "comics"
          }]),
          prowlarr_url: formData.prowlarr_url,
          prowlarr_key: formData.prowlarr_key,
          filter_enabled: formData.filter_enabled.toString(),
          filter_publishers: formData.filter_publishers,
          oidc_enabled: formData.oidc_enabled.toString(),
          oidc_issuer: formData.oidc_issuer,
          oidc_client_id: formData.oidc_client_id,
          oidc_client_secret: formData.oidc_client_secret,
          setup_complete: 'true' // CRITICAL FLAG
      };

      try {
          const res = await fetch('/api/admin/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(finalConfig)
          });
          
          if (res.ok) {
              toast({ title: "Setup Complete!", description: "Welcome to Omnibus." });
              router.push('/login'); // Send them to login with their new Admin account!
          } else {
              toast({ title: "Save Failed", description: "Could not save configurations.", variant: "destructive" });
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
      { id: 4, title: "Downloaders", icon: Download },
      { id: 5, title: "Indexers", icon: Search },
      { id: 6, title: "Extras", icon: Settings2 },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
      <title>Omnibus - Initial Setup</title>
      
      <div className="max-w-3xl w-full space-y-8">
        <div className="text-center space-y-2">
            <h1 className="text-4xl font-black tracking-tight text-slate-900 dark:text-white">Welcome to Omnibus.</h1>
            <p className="text-muted-foreground text-lg">Let's get your library configured and ready to read.</p>
        </div>

        {/* Progress Bar */}
        <div className="flex items-center justify-between relative px-4">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-slate-200 dark:bg-slate-800 -z-10 rounded-full">
                <div className="h-full bg-blue-500 transition-all duration-500 rounded-full" style={{ width: `${((step - 1) / 5) * 100}%` }} />
            </div>
            {steps.map(s => {
                const Icon = s.icon;
                const isActive = step === s.id;
                const isPast = step > s.id;
                return (
                    <div key={s.id} className="flex flex-col items-center gap-2 bg-slate-50 dark:bg-slate-950 px-2">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors ${isActive ? 'border-blue-500 bg-blue-500 text-white shadow-lg shadow-blue-500/20' : isPast ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-500' : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-400'}`}>
                            {isPast ? <CheckCircle2 className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
                        </div>
                        <span className={`text-xs font-bold ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}>{s.title}</span>
                    </div>
                )
            })}
        </div>

        <Card className="p-8 shadow-xl dark:bg-slate-900 border-slate-200 dark:border-slate-800 rounded-2xl relative overflow-hidden">
            {/* Step 1: Admin */}
            {step === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2"><ShieldCheck className="w-6 h-6 text-blue-500"/> Create Admin Account</h2>
                        <p className="text-muted-foreground mt-1">This will be your master key to Omnibus. Make it secure.</p>
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

            {/* Step 2: Metadata */}
            {step === 2 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2"><Database className="w-6 h-6 text-green-500"/> ComicVine API</h2>
                        <p className="text-muted-foreground mt-1">Omnibus uses ComicVine to automatically pull covers, synopses, and creator credits.</p>
                    </div>
                    <div className="space-y-4 bg-slate-50 dark:bg-slate-950 p-6 rounded-xl border dark:border-slate-800">
                        <div className="grid gap-2">
                            <Label>API Key <span className="text-red-500">*</span></Label>
                            <Input value={formData.cv_api_key} onChange={e => updateForm('cv_api_key', e.target.value)} placeholder="Enter your ComicVine Key..." className="h-12 bg-white dark:bg-slate-900"/>
                            <p className="text-xs text-muted-foreground mt-1">Don't have one? Get it for free at <a href="https://comicvine.gamespot.com/api/" target="_blank" className="text-blue-500 hover:underline">comicvine.gamespot.com/api</a>.</p>
                        </div>
                        <Button 
                            variant="secondary" 
                            className="w-full h-12 font-bold mt-2" 
                            disabled={!formData.cv_api_key || isTesting === 'cv'}
                            onClick={() => handleTestConnection('comicvine', { cv_api_key: formData.cv_api_key }, 'cv')}
                        >
                            {isTesting === 'cv' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />} 
                            {testResults['cv'] ? "Connection Verified!" : "Test Connection"}
                        </Button>
                    </div>
                </div>
            )}

            {/* Step 3: Storage */}
            {step === 3 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2"><HardDrive className="w-6 h-6 text-purple-500"/> Map Storage Paths</h2>
                        <p className="text-muted-foreground mt-1">Tell Omnibus where to store and organize your physical files.</p>
                    </div>
                    <div className="space-y-5">
                        <div className="space-y-2">
                            <Label>Main Library Path (Required)</Label>
                            <Input value={formData.library_path} onChange={e => updateForm('library_path', e.target.value)} placeholder="e.g. /data/comics or C:\Media\Comics" className="h-12 bg-white dark:bg-slate-950"/>
                        </div>
                        <div className="space-y-2">
                            <Label>Manga Library Path (Optional)</Label>
                            <Input value={formData.manga_library_path} onChange={e => updateForm('manga_library_path', e.target.value)} placeholder="e.g. /data/manga" className="h-12 bg-white dark:bg-slate-950"/>
                            <p className="text-xs text-muted-foreground">If provided, Omnibus will auto-route detected Manga here instead of the main folder.</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Step 4: Downloaders */}
            {step === 4 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2"><Download className="w-6 h-6 text-blue-500"/> Primary Download Client</h2>
                        <p className="text-muted-foreground mt-1">Connect your torrent or usenet client so Omnibus can send it downloads.</p>
                    </div>
                    <div className="space-y-4">
                        <div className="grid gap-2">
                            <Label>Client Type</Label>
                            <Select value={formData.clientType} onValueChange={v => updateForm('clientType', v)}>
                                <SelectTrigger className="h-12 bg-white dark:bg-slate-950"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="qbit">qBittorrent</SelectItem>
                                    <SelectItem value="sab">SABnzbd</SelectItem>
                                    <SelectItem value="deluge">Deluge</SelectItem>
                                    <SelectItem value="nzbget">NZBGet</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2">
                            <Label>Server URL</Label>
                            <Input value={formData.clientUrl} onChange={e => updateForm('clientUrl', e.target.value)} placeholder="http://192.168.1.100:8080" className="h-12 bg-white dark:bg-slate-950"/>
                        </div>
                        
                        {formData.clientType === 'sab' || formData.clientType === 'nzbget' ? (
                            <div className="grid gap-2">
                                <Label>API Key / Pass</Label>
                                <Input value={formData.clientApiKey} onChange={e => updateForm('clientApiKey', e.target.value)} className="h-12 bg-white dark:bg-slate-950"/>
                            </div>
                        ) : (
                            <div className="grid sm:grid-cols-2 gap-4">
                                <div className="grid gap-2"><Label>Username</Label><Input value={formData.clientUser} onChange={e => updateForm('clientUser', e.target.value)} className="h-12 bg-white dark:bg-slate-950"/></div>
                                <div className="grid gap-2"><Label>Password</Label><Input type="password" value={formData.clientPass} onChange={e => updateForm('clientPass', e.target.value)} className="h-12 bg-white dark:bg-slate-950"/></div>
                            </div>
                        )}
                        
                        <Button 
                            variant="secondary" 
                            className="w-full h-12 font-bold mt-4" 
                            disabled={!formData.clientUrl || isTesting === 'dl'}
                            onClick={() => handleTestConnection('clients', { clientType: formData.clientType, url: formData.clientUrl, user: formData.clientUser, pass: formData.clientPass, apiKey: formData.clientApiKey }, 'dl')}
                        >
                            {isTesting === 'dl' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />} 
                            {testResults['dl'] ? "Connection Verified!" : "Test Connection"}
                        </Button>
                    </div>
                </div>
            )}

            {/* Step 5: Indexers */}
            {step === 5 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2"><Search className="w-6 h-6 text-orange-500"/> Connect Prowlarr</h2>
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
                        <Button 
                            variant="secondary" 
                            className="w-full h-12 font-bold mt-4" 
                            disabled={!formData.prowlarr_url || !formData.prowlarr_key || isTesting === 'pr'}
                            onClick={() => handleTestConnection('prowlarr', { prowlarr_url: formData.prowlarr_url, prowlarr_key: formData.prowlarr_key }, 'pr')}
                        >
                            {isTesting === 'pr' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />} 
                            {testResults['pr'] ? "Connection Verified!" : "Test Connection"}
                        </Button>
                    </div>
                </div>
            )}

            {/* Step 6: Extras */}
            {step === 6 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2"><Settings2 className="w-6 h-6 text-pink-500"/> Optional Extras</h2>
                        <p className="text-muted-foreground mt-1">Fine-tune your setup. You can always change these later in Settings.</p>
                    </div>
                    <div className="space-y-6">
                        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-950 rounded-xl border dark:border-slate-800">
                            <div>
                                <Label className="text-base">Enable Content Filter</Label>
                                <p className="text-xs text-muted-foreground mt-1">Block specific keywords or publishers from the Discovery page.</p>
                            </div>
                            <Switch checked={formData.filter_enabled} onCheckedChange={v => updateForm('filter_enabled', v)} />
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
                    </div>
                </div>
            )}

            {/* Bottom Navigation */}
            <div className="mt-10 pt-6 border-t dark:border-slate-800 flex justify-between">
                <Button variant="ghost" disabled={step === 1 || isTesting === 'admin'} onClick={() => setStep(s => s - 1)}>Back</Button>
                
                {step < 6 ? (
                    <Button onClick={handleNext} disabled={isTesting === 'admin'} className="bg-blue-600 hover:bg-blue-700 text-white w-32 font-bold">
                        {isTesting === 'admin' ? <Loader2 className="w-5 h-5 animate-spin" /> : "Next Step"} <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                ) : (
                    <Button onClick={handleFinish} disabled={isTesting === 'finish'} className="bg-green-600 hover:bg-green-700 text-white w-40 font-bold text-lg h-12 shadow-lg shadow-green-500/20">
                        {isTesting === 'finish' ? <Loader2 className="w-5 h-5 animate-spin" /> : "Finish Setup"}
                    </Button>
                )}
            </div>
        </Card>
      </div>
    </div>
  )
}