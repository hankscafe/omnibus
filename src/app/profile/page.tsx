// src/app/profile/page.tsx
"use client"

import React, { useState, useEffect, useRef } from "react"
import { useSession } from "next-auth/react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"
import { useColorTheme } from "@/components/ThemeProvider"
import { 
  User as UserIcon, Upload, Loader2, ListOrdered, CheckCircle2, 
  Clock, XCircle, Activity, ArrowRight, Info, Calendar, BookOpen, 
  Trophy, History, Palette, Check, ImageIcon, Trash2, ChevronLeft, 
  ChevronRight, ShieldCheck, ShieldAlert, Key, LogOut, Webhook, Copy, 
  Plus, Smartphone, TabletSmartphone, Wifi, Flame, BookType, Sparkles, Layers
} from "lucide-react"

// --- Helper Component: Individual Activity Card ---
function ActivityCard({ req, getStatusBadge }: { req: any, getStatusBadge: (status: string) => React.ReactNode }) {
  const [desc, setDesc] = useState<string | null>(null)
  const [loadingDesc, setLoadingDesc] = useState(false)
  const [showDesc, setShowDesc] = useState(false)

  const handleShowDesc = async () => {
    if (showDesc) {
        setShowDesc(false);
        return;
    }
    setShowDesc(true);
    if (!desc && req.volumeId) {
        setLoadingDesc(true);
        try {
            const issueMatch = req.seriesName?.match(/#(\d+)/);
            if (issueMatch) {
                const targetIssueNum = parseFloat(issueMatch[1]);
                const [volRes, issuesRes] = await Promise.all([
                    fetch(`/api/issue-details?id=${req.volumeId}&type=volume`),
                    fetch(`/api/series-issues?volumeId=${req.volumeId}`)
                ]);
                const volData = await volRes.json();
                const issuesData = await issuesRes.json();
                const specificIssue = issuesData.results?.find((i: any) => parseFloat(i.issueNumber) === targetIssueNum);
                const finalDesc = specificIssue?.description || volData.description;
                setDesc(finalDesc ? finalDesc.trim() : "No synopsis available.");
            } else {
                const res = await fetch(`/api/issue-details?id=${req.volumeId}&type=volume`);
                const data = await res.json();
                setDesc(data.description ? data.description.trim() : "No synopsis available.");
            }
        } catch (e) {
            setDesc("Failed to load synopsis.");
        } finally {
            setLoadingDesc(false);
        }
    } else if (!desc && !req.volumeId) {
        setDesc("No Volume ID associated with this request.");
    }
  }

  const displayName = (req.seriesName || "Unknown Request").replace(/\.(cbz|cbr|zip)$/i, '');
  const isCompleted = ['IMPORTED', 'COMPLETED'].includes(req.status);

  return (
    <div className="p-4 flex flex-col sm:flex-row gap-4 hover:bg-muted/50 transition-colors">
        <div className="w-24 h-36 sm:w-28 sm:h-40 bg-muted rounded shadow-sm border overflow-hidden shrink-0">
            {req.imageUrl ? <img src={req.imageUrl} className="w-full h-full object-cover" alt="" /> : null}
        </div>
        <div className="min-w-0 flex-1 flex flex-col justify-between">
            <div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                    <p className="font-bold text-base truncate" title={displayName}>{displayName}</p>
                    <div className="shrink-0">{getStatusBadge(req.status)}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={handleShowDesc} className="h-7 px-2 text-[11px] font-bold text-primary hover:text-primary/80 hover:bg-primary/10 -ml-2 mb-1">
                    <Info className="w-3 h-3 mr-1" /> {showDesc ? "Hide Synopsis" : "Read Synopsis"}
                </Button>
                {showDesc && (
                    <div className="text-xs text-muted-foreground leading-relaxed bg-muted/80 p-3 rounded border mt-1 animate-in fade-in slide-in-from-top-1">
                        {loadingDesc ? <Loader2 className="w-3 h-3 animate-spin" /> : desc}
                    </div>
                )}
            </div>
            <div className="flex flex-wrap gap-4 mt-3">
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> Requested: {new Date(req.createdAt).toLocaleDateString()}
                </p>
                {isCompleted && req.updatedAt && (
                    <p className="text-[10px] text-green-600 dark:text-green-500 font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Completed: {new Date(req.updatedAt).toLocaleDateString()}
                    </p>
                )}
            </div>
        </div>
    </div>
  )
}

const getThemeGradient = (theme: string) => {
    switch (theme) {
      case 'vigilante': return 'from-red-700 via-red-900 to-slate-900';
      case 'krypton': return 'from-green-600 via-green-800 to-slate-900';
      case 'mutant': return 'from-yellow-600 via-amber-700 to-slate-900';
      case 'symbiote': return 'from-slate-800 via-slate-950 to-black';
      case 'speedster': return 'from-red-700 via-red-900 to-yellow-900';
      default: return 'from-blue-700 via-indigo-800 to-slate-900';
    }
}

// --- Helper Component: KOReader Devices Sync ---
function KoreaderDevices() {
    const [devices, setDevices] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchDevices = async () => {
            try {
                const res = await fetch('/api/profile/koreader');
                if (res.ok) {
                    const data = await res.json();
                    setDevices(data);
                }
            } catch (e) {
                console.error("Failed to load KOReader devices", e);
            } finally {
                setLoading(false);
            }
        };
        fetchDevices();
    }, []);

    if (loading) {
        return <div className="animate-pulse h-32 bg-muted rounded-xl border border-border mt-6"></div>;
    }

    if (devices.length === 0) {
        return null; // Hide the section entirely if they haven't synced an eReader yet
    }

    return (
        <Card className="shadow-sm border-border bg-background mt-6">
            <CardHeader className="pb-3 border-b border-border bg-muted/30">
                <div className="flex items-center gap-2">
                    <TabletSmartphone className="w-5 h-5 text-primary" />
                    <CardTitle className="text-lg">Connected eReaders</CardTitle>
                </div>
                <CardDescription>Devices actively syncing reading progress via KOReader.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 pt-4">
                {devices.map((device) => {
                    // Convert KOReader's unix timestamp to a readable date
                    const syncDate = new Date(device.lastSync * 1000);
                    const timeAgo = Math.round((Date.now() - syncDate.getTime()) / 60000); // minutes
                    
                    let timeString = `${timeAgo} mins ago`;
                    if (timeAgo > 60) timeString = `${Math.round(timeAgo / 60)} hours ago`;
                    if (timeAgo > 1440) timeString = `${Math.round(timeAgo / 1440)} days ago`;
                    if (timeAgo < 1) timeString = "Just now";

                    return (
                        <div key={device.deviceId} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border border-border bg-muted/20 hover:bg-muted/50 transition-colors">
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 border border-primary/20">
                                    <TabletSmartphone className="w-5 h-5 text-primary" />
                                </div>
                                <div>
                                    <h4 className="font-bold text-foreground flex items-center gap-2">
                                        {device.deviceName}
                                        <Badge variant="secondary" className="text-[9px] h-4 bg-green-500/10 text-green-600 border-green-500/20 uppercase tracking-wider">
                                            <Wifi className="w-2.5 h-2.5 mr-1" /> Synced
                                        </Badge>
                                    </h4>
                                    <p className="text-xs text-muted-foreground font-mono mt-0.5">ID: {device.deviceId}</p>
                                </div>
                            </div>

                            <div className="flex flex-col sm:items-end gap-1.5 min-w-0 sm:max-w-[40%]">
                                <div className="flex items-center gap-1.5 text-xs text-foreground truncate w-full sm:justify-end">
                                    <BookOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                    <span className="truncate font-medium">{device.lastDocument}</span>
                                </div>
                                <div className="flex items-center gap-2 w-full sm:justify-end">
                                    <div className="flex-1 sm:flex-none sm:w-24 h-1.5 bg-background border border-border rounded-full overflow-hidden">
                                        <div 
                                            className="h-full bg-primary" 
                                            style={{ width: `${Math.max(0, Math.min(100, device.percentage * 100))}%` }} 
                                        />
                                    </div>
                                    <span className="text-[10px] font-bold text-muted-foreground w-8 text-right shrink-0">
                                        {Math.round(device.percentage * 100)}%
                                    </span>
                                </div>
                                <div className="flex items-center gap-1 text-[10px] text-muted-foreground sm:justify-end mt-0.5">
                                    <Clock className="w-3 h-3" /> Last sync: {timeString}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
}

export default function ProfilePage() {
  const { data: session, update } = useSession()
  const [profile, setProfile] = useState<any>(null)
  const [recentReqs, setRecentReqs] = useState<any[]>([])
  const [readingLists, setReadingLists] = useState<any[]>([])
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  
  // Upload States
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const fileAvatarRef = useRef<HTMLInputElement>(null)
  const fileBannerRef = useRef<HTMLInputElement>(null)
  
  // 2FA States
  const [is2FAEnabled, setIs2FAEnabled] = useState(false)
  const [setup2faModalOpen, setSetup2faModalOpen] = useState(false)
  const [disable2faModalOpen, setDisable2faModalOpen] = useState(false)
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null)
  const [totpSecret, setTotpSecret] = useState<string | null>(null)
  const [verifyCode, setVerifyCode] = useState("")
  const [isProcessing2fa, setIsProcessing2fa] = useState(false)

  // Security Modal States
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [revokeModalOpen, setRevokeModalOpen] = useState(false)
  const [isProcessingSecurity, setIsProcessingSecurity] = useState(false)
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" })

  // User API Keys State
  const [apiKeys, setApiKeys] = useState<any[]>([])
  const [manageKeysModalOpen, setManageKeysModalOpen] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [isGeneratingKey, setIsGeneratingKey] = useState(false)

  // History Pagination
  const [historyPage, setHistoryPage] = useState(0)
  const historyItemsPerPage = 6;
  const totalHistoryPages = Math.ceil((profile?.recentHistory?.length || 0) / historyItemsPerPage);
  const displayedHistory = profile?.recentHistory?.slice(historyPage * historyItemsPerPage, (historyPage + 1) * historyItemsPerPage) || [];

  const { toast } = useToast()
  const { colorTheme, setColorTheme } = useColorTheme()

  const fetchData = async () => {
    if (!session?.user?.id) return;
    try {
      const profRes = await fetch('/api/user/profile')
      if (profRes.ok) setProfile(await profRes.json())

      // --- FIXED: Hit the user-facing request endpoint ---
      const reqRes = await fetch('/api/request')
      if (reqRes.ok) {
        const data = await reqRes.json()
        setRecentReqs(data.slice(0, 5)); // Backend automatically filters this now
      }

      const listRes = await fetch('/api/reading-lists')
      if (listRes.ok) setReadingLists(await listRes.json());

      const tfaRes = await fetch('/api/user/2fa')
      if (tfaRes.ok) {
        const tfaData = await tfaRes.json()
        setIs2FAEnabled(tfaData.enabled)
      }

      const keysRes = await fetch('/api/user/api-keys')
      if (keysRes.ok) setApiKeys(await keysRes.json())

      const analyticsRes = await fetch('/api/user/analytics')
      if (analyticsRes.ok) setAnalytics(await analyticsRes.json())

    } catch (e) {
      toast({ title: "Error", description: "Failed to load profile data.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { 
      if (session?.user?.id) fetchData() 
  }, [session])

  // --- HEATMAP GENERATOR HELPER ---
  const renderHeatmap = () => {
      if (!analytics?.heatmap) return null;
      
      const today = new Date();
      const days = [];
      // Generate the last 180 days
      for (let i = 180; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().split('T')[0];
          const pagesRead = analytics.heatmap[dateStr] || 0;
          
          let colorClass = "bg-muted/50 border-border"; 
          if (pagesRead > 0 && pagesRead <= 15) colorClass = "bg-primary/30 border-primary/20";
          else if (pagesRead > 15 && pagesRead <= 50) colorClass = "bg-primary/60 border-primary/40";
          else if (pagesRead > 50) colorClass = "bg-primary border-primary/80";

          days.push(
              <div 
                  key={dateStr} 
                  title={`${dateStr}: ${pagesRead} pages read`}
                  className={`w-3 h-3 sm:w-4 sm:h-4 rounded-sm border ${colorClass} transition-colors hover:ring-2 hover:ring-foreground`}
              />
          );
      }

      return (
          <div className="flex flex-wrap gap-1 mt-4 p-4 bg-muted/20 border border-border rounded-xl justify-end">
              {days}
          </div>
      );
  }

  // --- 2FA Handlers ---
  const handleBegin2FASetup = async () => {
      setIsProcessing2fa(true)
      try {
          const res = await fetch('/api/user/2fa', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'generate' })
          })
          const data = await res.json()
          if (res.ok) {
              setTotpSecret(data.secret)
              setQrCodeDataUrl(data.qrCode)
              setVerifyCode("")
              setSetup2faModalOpen(true)
          } else {
              toast({ title: "Error", description: data.error, variant: "destructive" })
          }
      } catch (e) {
          toast({ title: "Error", description: "Network error", variant: "destructive" })
      } finally {
          setIsProcessing2fa(false)
      }
  }

  const handleVerifyAndEnable2FA = async () => {
      if (verifyCode.length !== 6) return toast({ title: "Invalid Code", description: "Code must be 6 digits.", variant: "destructive" });
      setIsProcessing2fa(true)
      try {
          const res = await fetch('/api/user/2fa', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'enable', secret: totpSecret, code: verifyCode })
          })
          const data = await res.json()
          if (res.ok) {
              toast({ title: "2FA Enabled", description: data.message })
              setIs2FAEnabled(true)
              setSetup2faModalOpen(false)
          } else {
              toast({ title: "Verification Failed", description: data.error, variant: "destructive" })
          }
      } catch (e) {
          toast({ title: "Error", description: "Network error", variant: "destructive" })
      } finally {
          setIsProcessing2fa(false)
      }
  }

  const handleDisable2FA = async () => {
      setIsProcessing2fa(true)
      try {
          const res = await fetch('/api/user/2fa', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'disable' })
          })
          const data = await res.json()
          if (res.ok) {
              toast({ title: "2FA Disabled", description: data.message })
              setIs2FAEnabled(false)
              setDisable2faModalOpen(false)
          } else {
              toast({ title: "Error", description: data.error, variant: "destructive" })
          }
      } catch (e) {
          toast({ title: "Error", description: "Network error", variant: "destructive" })
      } finally {
          setIsProcessing2fa(false)
      }
  }

  // --- Security Handlers ---
  const handlePasswordChange = async () => {
      if (passwords.new !== passwords.confirm) return toast({ title: "Error", description: "New passwords do not match.", variant: "destructive" });
      if (passwords.new.length < 12) return toast({ title: "Weak Password", description: "Password must be at least 12 characters.", variant: "destructive" });
      
      setIsProcessingSecurity(true);
      try {
          const res = await fetch('/api/user/security', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'change_password', currentPassword: passwords.current, newPassword: passwords.new })
          });
          const data = await res.json();
          if (res.ok) {
              toast({ title: "Success", description: data.message });
              setPasswordModalOpen(false);
              setPasswords({ current: "", new: "", confirm: "" });
          } else throw new Error(data.error);
      } catch (e: any) {
          toast({ title: "Error", description: e.message, variant: "destructive" });
      } finally { setIsProcessingSecurity(false); }
  }

  const handleRevokeSessions = async () => {
      setIsProcessingSecurity(true);
      try {
          const res = await fetch('/api/user/security', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'revoke_sessions' })
          });
          const data = await res.json();
          if (res.ok) {
              toast({ title: "Sessions Revoked", description: data.message });
              setRevokeModalOpen(false);
              update({ sessionVersion: data.newSessionVersion }).catch(()=>{});
          } else throw new Error(data.error);
      } catch (e: any) {
          toast({ title: "Error", description: e.message, variant: "destructive" });
      } finally { setIsProcessingSecurity(false); }
  }

  const handleGenerateKey = async () => {
      setIsGeneratingKey(true);
      setGeneratedKey(null);
      try {
          const res = await fetch('/api/user/api-keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newKeyName || 'Mobile Reader App' })
          });
          const data = await res.json();
          if (res.ok && data.success) {
              setGeneratedKey(data.rawKey);
              setApiKeys([data.apiKey, ...apiKeys]);
              setNewKeyName("");
          } else {
              toast({ title: "Error", description: data.error, variant: "destructive" });
          }
      } finally { setIsGeneratingKey(false); }
  }

  const handleRevokeKey = async (id: string) => {
      const res = await fetch(`/api/user/api-keys?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
          setApiKeys(prev => prev.filter(k => k.id !== id));
          toast({ title: "Key Revoked" });
      }
  }

  const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      toast({ title: "Copied!", description: "API Key copied to clipboard." });
  }

  // --- Avatar/Banner Handlers ---
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast({ title: "File too large", description: "Avatar must be under 5MB.", variant: "destructive" });
    setUploadingAvatar(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
        try {
            const res = await fetch('/api/user/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatarBase64: reader.result })
            });
            const data = await res.json();
            if (res.ok) {
                toast({ title: "Avatar Updated" });
                setProfile((prev: any) => ({ ...prev, user: { ...prev.user, avatar: data.avatarUrl } }));
                await update({ user: { image: data.avatarUrl } });
            } else throw new Error(data.error);
        } catch (err: any) { toast({ title: "Upload Failed", description: err.message, variant: "destructive" }); } finally { setUploadingAvatar(false); }
    };
    reader.readAsDataURL(file);
  }

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast({ title: "File too large", description: "Banner must be under 10MB.", variant: "destructive" });
    setUploadingBanner(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
        try {
            const res = await fetch('/api/user/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bannerBase64: reader.result })
            });
            const data = await res.json();
            if (res.ok) {
                toast({ title: "Banner Updated" });
                setProfile((prev: any) => ({ ...prev, user: { ...prev.user, banner: data.bannerUrl } }));
            } else throw new Error(data.error);
        } catch (err: any) { toast({ title: "Upload Failed", description: err.message, variant: "destructive" }); } finally { setUploadingBanner(false); }
    };
    reader.readAsDataURL(file);
  }

  const handleRemoveBanner = async (e: React.MouseEvent) => {
    e.stopPropagation(); setUploadingBanner(true);
    try {
        const res = await fetch('/api/user/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeBanner: true }) });
        if (res.ok) setProfile((prev: any) => ({ ...prev, user: { ...prev.user, banner: null } }));
    } finally { setUploadingBanner(false); }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'IMPORTED': case 'COMPLETED': return <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 text-[10px] uppercase font-bold">In Library</Badge>;
      case 'DOWNLOADING': return <Badge variant="outline" className="bg-primary/20 text-primary border-primary/30 text-[10px] uppercase font-bold">Downloading</Badge>;
      case 'PENDING_APPROVAL': return <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 text-[10px] uppercase font-bold text-center leading-tight">Needs Approval</Badge>;
      case 'FAILED': case 'STALLED': case 'ERROR': return <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 text-[10px] uppercase font-bold">Failed</Badge>;
      default: return <Badge variant="outline" className="bg-muted text-foreground border-border text-[10px] uppercase font-bold">Pending</Badge>;
    }
  }

  const themes = [
    { id: 'default', name: 'Omnibus Base', color: 'bg-[#2563EB]' },
    { id: 'vigilante', name: 'Vigilante', color: 'bg-[#DC2626]' }, 
    { id: 'krypton', name: 'Krypton', color: 'bg-[#22C55E]' }, 
    { id: 'mutant', name: 'Mutant', color: 'bg-[#EAB308]' }, 
    { id: 'symbiote', name: 'Symbiote', color: 'bg-black dark:bg-white border dark:border-slate-800' }, 
    { id: 'speedster', name: 'Speedster', color: 'bg-[#DC2626] border-2 border-yellow-500' }, 
  ];

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="min-h-screen pb-20 transition-colors duration-300">
      <title>Omnibus - Profile</title>
      
      <div className="relative h-48 sm:h-64 w-full group overflow-hidden bg-slate-900">
        {profile?.user?.banner ? (
            <img src={profile.user.banner.startsWith('/') ? profile.user.banner : `/${profile.user.banner}`} alt="Banner" className="w-full h-full object-cover transition-all duration-300 group-hover:scale-105 group-hover:blur-sm opacity-90" />
        ) : (
            <div className={`absolute inset-0 bg-gradient-to-r ${getThemeGradient(colorTheme)} transition-all duration-300 group-hover:blur-sm`}>
                <div className="absolute inset-0 opacity-20 bg-[url('/images/omnibus-branding.jpg')] bg-cover mix-blend-overlay" />
            </div>
        )}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4 bg-black/30">
            {uploadingBanner ? <Loader2 className="w-8 h-8 animate-spin text-white" /> : (
                <>
                    <div className="text-center text-white flex flex-col items-center bg-black/60 px-6 py-4 rounded-xl backdrop-blur-md border border-white/10 shadow-2xl transition-transform hover:scale-105 cursor-pointer" onClick={() => fileBannerRef.current?.click()}>
                        <ImageIcon className="w-8 h-8 mb-2" />
                        <span className="font-black uppercase tracking-widest text-sm">Update Banner</span>
                        <span className="text-[11px] text-white/80 mt-1 font-medium bg-black/50 px-2 py-1 rounded">Recommended: 1920x400 (72 DPI)</span>
                    </div>
                    {profile?.user?.banner && (
                        <div className="text-center text-white flex flex-col items-center bg-red-600/80 px-6 py-4 rounded-xl backdrop-blur-md border border-red-500/50 shadow-2xl transition-transform hover:scale-105 cursor-pointer" onClick={handleRemoveBanner}>
                            <Trash2 className="w-8 h-8 mb-2" />
                            <span className="font-black uppercase tracking-widest text-sm">Remove</span>
                            <span className="text-[11px] text-white/80 mt-1 font-medium bg-black/20 px-2 py-1 rounded">Reset to Default</span>
                        </div>
                    )}
                </>
            )}
        </div>
        <input type="file" ref={fileBannerRef} className="hidden" accept="image/png, image/jpeg, image/webp" onChange={handleBannerUpload} />
      </div>

      <div className="container mx-auto px-6 max-w-5xl relative -mt-20 sm:-mt-24 space-y-8">
        <div className="flex flex-col sm:flex-row items-center sm:items-end gap-6">
            <div className="relative group cursor-pointer" onClick={() => fileAvatarRef.current?.click()}>
                <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-full border-4 border-background bg-muted overflow-hidden flex items-center justify-center shadow-xl relative z-10 transition-transform group-hover:scale-105">
                    {uploadingAvatar ? <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /> : profile?.user?.avatar ? <img src={profile.user.avatar.startsWith('/') ? profile.user.avatar : `/${profile.user.avatar}`} alt="Avatar" className="w-full h-full object-cover" /> : <UserIcon className="w-16 h-16 text-muted-foreground" />}
                </div>
                <div className="absolute inset-0 z-20 rounded-full bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white border-4 border-transparent">
                    <Upload className="w-6 h-6 mb-1" />
                    <span className="text-xs font-bold uppercase tracking-wider">Change</span>
                </div>
                <input type="file" ref={fileAvatarRef} className="hidden" accept="image/png, image/jpeg, image/webp" onChange={handleAvatarUpload} />
            </div>

            <div className="text-center sm:text-left mb-2 sm:mb-4 space-y-1 drop-shadow-md sm:drop-shadow-none">
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-foreground sm:text-white drop-shadow-lg">{profile?.user?.username}</h1>
                <div className="flex items-center justify-center sm:justify-start gap-2 bg-background/80 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none py-1 sm:py-0 px-3 sm:px-0 rounded-full w-fit mx-auto sm:mx-0">
                    <Badge className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold uppercase tracking-wider text-[10px]">{profile?.user?.role}</Badge>
                    <span className="text-xs text-muted-foreground sm:text-slate-200 font-medium sm:drop-shadow-md">Member since {new Date(profile?.user?.createdAt).getFullYear()}</span>
                </div>
            </div>
        </div>

        {/* --- SECURITY (GRID) SECTION --- */}
        <div className="space-y-3 pt-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <ShieldCheck className="w-4 h-4" /> Account Security
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* CARD 1: 2FA */}
                <Card className={`shadow-sm border-2 flex flex-col ${is2FAEnabled ? 'border-green-200 bg-green-50/20 dark:border-green-900/40 dark:bg-green-900/10' : ''}`}>
                    <CardContent className="p-4 sm:p-6 flex flex-col h-full gap-4">
                        <div className="space-y-1 flex-1">
                            <div className="flex items-center gap-2 mb-2">
                                <h4 className={`font-bold text-lg leading-none ${is2FAEnabled ? 'text-green-800 dark:text-green-400' : ''}`}>Two-Factor Auth</h4>
                                {is2FAEnabled && <Badge className="bg-green-500 hover:bg-green-600 border-0 h-5 px-1.5 text-[10px]"><Check className="w-3 h-3 mr-1"/> ON</Badge>}
                            </div>
                            <p className={`text-xs ${is2FAEnabled ? 'text-green-700/80 dark:text-green-500/80' : 'text-muted-foreground'}`}>
                                {is2FAEnabled ? "Secured with a TOTP authenticator app." : "Require a 6-digit code when logging in."}
                            </p>
                        </div>
                        {is2FAEnabled ? (
                            <Button variant="outline" className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/50 dark:hover:bg-red-900/30" onClick={() => setDisable2faModalOpen(true)}>Disable 2FA</Button>
                        ) : (
                            <Button className="w-full font-bold bg-primary hover:bg-primary/90 text-primary-foreground" onClick={handleBegin2FASetup} disabled={isProcessing2fa}>
                                {isProcessing2fa ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />} Enable 2FA
                            </Button>
                        )}
                    </CardContent>
                </Card>

                {/* CARD 2: PASSWORD RESET */}
                <Card className="shadow-sm flex flex-col">
                    <CardContent className="p-4 sm:p-6 flex flex-col h-full gap-4">
                        <div className="space-y-1 flex-1">
                            <h4 className="font-bold text-lg flex items-center gap-2 mb-2">
                                <Key className="w-4 h-4 text-primary" /> Password
                            </h4>
                            <p className="text-xs text-muted-foreground">Update your local account password. SSO users must change passwords at their provider.</p>
                        </div>
                        <Button variant="outline" className="w-full" onClick={() => setPasswordModalOpen(true)}>
                            Change Password
                        </Button>
                    </CardContent>
                </Card>

                {/* CARD 3: REVOKE SESSIONS */}
                <Card className="shadow-sm flex flex-col">
                    <CardContent className="p-4 sm:p-6 flex flex-col h-full gap-4">
                        <div className="space-y-1 flex-1">
                            <h4 className="font-bold text-lg flex items-center gap-2 mb-2">
                                <LogOut className="w-4 h-4 text-orange-500" /> Active Sessions
                            </h4>
                            <p className="text-xs text-muted-foreground">Logged in on a public computer? Sign out of all other devices immediately.</p>
                        </div>
                        <Button variant="outline" className="w-full text-orange-600 border-orange-200 hover:bg-orange-50 dark:border-orange-900/50 dark:hover:bg-orange-900/30" onClick={() => setRevokeModalOpen(true)}>
                            Revoke Sessions
                        </Button>
                    </CardContent>
                </Card>

                {/* CARD 4: EXTERNAL APPS (OPDS) */}
                <Card className="shadow-sm flex flex-col">
                    <CardContent className="p-4 sm:p-6 flex flex-col h-full gap-4">
                        <div className="space-y-1 flex-1">
                            <h4 className="font-bold text-lg flex items-center gap-2 mb-2">
                                <Smartphone className="w-4 h-4 text-purple-500" /> External Apps
                            </h4>
                            <p className="text-xs text-muted-foreground">Generate API keys to sync your library in apps like Panels, Mihon, and Paperback via OPDS.</p>
                        </div>
                        <Button variant="outline" className="w-full border-purple-200 text-purple-600 hover:bg-purple-50 dark:border-purple-900/50 dark:hover:bg-purple-900/30" onClick={() => setManageKeysModalOpen(true)}>
                            Manage API Keys
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </div>

        {/* CUSTOM THEME SELECTOR */}
        <div className="space-y-3">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <Palette className="w-4 h-4" /> App Appearance
            </h3>
            <Card className="shadow-sm bg-muted/30">
                <CardContent className="p-4 sm:p-6">
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                        {themes.map(t => (
                            <button 
                                key={t.id} 
                                onClick={() => setColorTheme(t.id)}
                                className={`flex flex-col items-center gap-3 p-3 rounded-xl border-2 transition-all ${colorTheme === t.id ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border'}`}
                            >
                                <div className={`w-10 h-10 rounded-full shadow-sm flex items-center justify-center ${t.color}`}>
                                    {colorTheme === t.id && <Check className={`w-5 h-5 ${t.id === 'symbiote' ? 'text-white dark:text-black' : 'text-white'}`} />}
                                </div>
                                <span className="text-xs font-bold text-foreground">{t.name}</span>
                            </button>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>

        {/* KOREADER SYNC SECTION */}
        <KoreaderDevices />

        {/* --- CURATED READING LISTS --- */}
        <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <ListOrdered className="w-4 h-4" /> Curated Reading Lists
                </h3>
                <Button variant="ghost" size="sm" asChild className="hidden sm:flex text-xs font-bold text-muted-foreground hover:text-foreground">
                    <Link href="/reading-lists">Manage Lists <ArrowRight className="w-3 h-3 ml-1.5" /></Link>
                </Button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {readingLists.slice(0, 3).map(list => (
                    <Link key={list.id} href={`/reading-lists?id=${list.id}`}>
                        <Card className="shadow-sm hover:border-primary transition-all h-full bg-muted/50 hover:shadow-md">
                            <CardContent className="p-4 flex gap-4">
                                <div className="w-14 h-20 bg-background rounded border overflow-hidden shrink-0 flex items-center justify-center">
                                    {list.coverUrl ? <img src={list.coverUrl} className="w-full h-full object-cover" alt="" /> : <ListOrdered className="w-6 h-6 text-muted-foreground/50" />}
                                </div>
                                <div className="flex flex-col justify-center">
                                    <h4 className="font-bold text-sm line-clamp-2 leading-tight">{list.name}</h4>
                                    <p className="text-xs font-bold text-primary mt-1">{list.items?.length || 0} Issues</p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>
                ))}
                {readingLists.length === 0 && (
                    <div className="col-span-full p-8 text-center border-2 border-dashed rounded-xl border-border bg-muted/50">
                        <ListOrdered className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" />
                        <p className="text-sm font-bold text-foreground">No reading lists yet.</p>
                        <p className="text-xs text-muted-foreground mt-1 mb-4">Create curated events to read your comics in the perfect order!</p>
                        <Button variant="outline" size="sm" asChild>
                            <Link href="/reading-lists">Create an Event</Link>
                        </Button>
                    </div>
                )}
            </div>
            {readingLists.length > 0 && (
                <div className="sm:hidden pt-2">
                    <Button variant="outline" className="w-full" asChild>
                        <Link href="/reading-lists">Manage Reading Lists</Link>
                    </Button>
                </div>
            )}
        </div>

        {/* --- RECENT READING HISTORY --- */}
        {profile?.recentHistory && profile.recentHistory.length > 0 && (
            <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-1 mb-2">
                    <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                        <History className="w-4 h-4" /> Reading History
                    </h3>
                    
                    <div className="flex items-center justify-between sm:justify-end gap-3 w-full sm:w-auto">
                        <Button variant="ghost" size="sm" className="h-8 text-xs font-bold text-muted-foreground hover:text-foreground hidden sm:flex" asChild>
                            {/* FIX: Link changed to library/history */}
                            <Link href="/library/history">View Full History <ArrowRight className="w-3 h-3 ml-1.5" /></Link>
                        </Button>
                        <div className="flex items-center gap-2 bg-background p-1 rounded-md shadow-sm border">
                            {/* @ts-ignore */}
                            <Button variant="ghost" size="icon-xs" className="h-7 w-7 p-0" onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0}><ChevronLeft className="h-4 w-4" /></Button>
                            <span className="text-xs font-mono w-4 text-center">{historyPage + 1}</span>
                            {/* @ts-ignore */}
                            <Button variant="ghost" size="icon-xs" className="h-7 w-7 p-0" onClick={() => setHistoryPage(p => Math.min(totalHistoryPages - 1, p + 1))} disabled={historyPage >= totalHistoryPages - 1}><ChevronRight className="h-4 w-4" /></Button>
                        </div>
                    </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {displayedHistory.map((item: any) => {
                        const coverSource = item.coverUrl; // Simplifed since API does the fallback now
                        return (
                            <Link key={item.id} href={`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.folderPath)}`} className="block group">
                                <Card className="shadow-sm bg-muted/50 overflow-hidden group-hover:border-primary/50 transition-colors h-full">
                                    <CardContent className="p-4 flex items-center gap-4">
                                        <div className="w-14 h-20 bg-background rounded shrink-0 border flex items-center justify-center overflow-hidden relative">
                                            {coverSource ? <img src={coverSource} className="w-full h-full object-cover absolute inset-0 z-10" alt="" onError={(e) => { e.currentTarget.style.opacity = '0'; }} /> : null}
                                            <BookOpen className="w-5 h-5 text-muted-foreground absolute z-0" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-bold text-sm truncate group-hover:text-primary transition-colors" title={item.seriesName}>{item.seriesName}</p>
                                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mt-0.5">Issue #{item.issueNumber}</p>
                                            <div className="mt-2.5 flex items-center gap-2">
                                                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className={`h-full ${item.isCompleted ? 'bg-green-500' : 'bg-primary'}`} style={{ width: `${item.progress}%` }} /></div>
                                                <span className="text-[9px] font-black text-muted-foreground w-8 text-right">{item.isCompleted ? 'DONE' : `${item.progress}%`}</span>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </Link>
                        );
                    })}
                </div>
            </div>
        )}

        {/* --- STATS SECTION --- */}
        <div className="space-y-3">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <BookOpen className="w-4 h-4" /> Overall Progress
            </h3>
            
            <Card className="shadow-sm bg-muted/50 overflow-hidden">
                <CardContent className="p-6">
                    <div className="flex items-center justify-between mb-4">
                        <div className="space-y-1">
                            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Completion Rate</p>
                            <p className="text-2xl font-black">{profile?.stats?.completionRate || 0}%</p>
                        </div>
                        <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 font-bold">
                            {profile?.stats?.historyCompleted || 0} / {profile?.stats?.historyStarted || 0} Finished
                        </Badge>
                    </div>
                    <div className="w-full h-3 bg-background rounded-full overflow-hidden">
                        <div className="h-full bg-primary transition-all duration-1000 ease-out" style={{ width: `${profile?.stats?.completionRate || 0}%` }} />
                    </div>
                </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-4">
                <Card className="shadow-sm bg-muted/50"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><History className="w-5 h-5 text-primary mb-1" /><span className="text-2xl font-black">{profile?.stats?.historyStarted || 0}</span><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Started</span></CardContent></Card>
                <Card className="shadow-sm bg-muted/50"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><Trophy className="w-5 h-5 text-emerald-500 mb-1" /><span className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{profile?.stats?.historyCompleted || 0}</span><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Finished</span></CardContent></Card>
            </div>
            
            {/* NEW: PERSONAL WRAPPED ANALYTICS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                <Card className="shadow-sm border-primary/20 bg-primary/5">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1 h-full">
                        <Layers className="w-5 h-5 text-primary mb-1" />
                        <span className="text-xl font-black text-foreground">{analytics?.topPublisher || "-"}</span>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Top Publisher</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm bg-muted/50">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1 h-full">
                        <BookType className="w-5 h-5 text-blue-500 mb-1" />
                        <span className="text-xl font-black text-foreground">{analytics?.topGenre || "-"}</span>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Top Genre</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm bg-muted/50">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1 h-full">
                        <Sparkles className="w-5 h-5 text-yellow-500 mb-1" />
                        <span className="text-xl font-black text-foreground">{analytics?.topCharacter || "-"}</span>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Top Character</span>
                    </CardContent>
                </Card>
            </div>

            {/* NEW: READING HEATMAP */}
            <Card className="shadow-sm bg-background border-border mt-4 overflow-hidden">
                <CardHeader className="pb-0 pt-6 px-6">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Flame className="w-5 h-5 text-orange-500" /> Reading Activity (Last 6 Months)
                        </CardTitle>
                        <Badge variant="secondary" className="font-mono text-[10px]">
                            {analytics?.totalPagesReadThisYear || 0} Pages Read
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent className="p-6">
                    {renderHeatmap()}
                    <div className="flex justify-end items-center gap-2 mt-3 text-[10px] text-muted-foreground font-bold uppercase">
                        <span>Less</span>
                        <div className="w-3 h-3 rounded-sm bg-muted/50 border border-border" />
                        <div className="w-3 h-3 rounded-sm bg-primary/30 border border-primary/20" />
                        <div className="w-3 h-3 rounded-sm bg-primary/60 border border-primary/40" />
                        <div className="w-3 h-3 rounded-sm bg-primary border border-primary/80" />
                        <span>More</span>
                    </div>
                </CardContent>
            </Card>
        </div>

        <div className="space-y-3">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <Upload className="w-4 h-4" /> Request Statistics
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <Card className="shadow-sm bg-muted/50"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><ListOrdered className="w-5 h-5 text-muted-foreground mb-1" /><span className="text-2xl font-black">{profile?.stats?.total}</span><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Total</span></CardContent></Card>
                <Card className="shadow-sm border-blue-200 bg-blue-50/30 dark:border-blue-900/30 dark:bg-blue-900/10"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><Activity className="w-5 h-5 text-blue-500 mb-1" /><span className="text-2xl font-black text-blue-600 dark:text-blue-400">{profile?.stats?.active}</span><span className="text-[10px] font-bold text-blue-800/70 dark:text-blue-400/70 uppercase tracking-wider">Active</span></CardContent></Card>
                <Card className="shadow-sm border-orange-200 bg-orange-50/30 dark:border-orange-900/30 dark:bg-orange-900/10"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><Clock className="w-5 h-5 text-orange-500 mb-1" /><span className="text-2xl font-black text-orange-600 dark:text-orange-400">{profile?.stats?.pendingApproval}</span><span className="text-[10px] font-bold text-orange-800/70 dark:text-orange-400/70 uppercase tracking-wider">Pending</span></CardContent></Card>
                <Card className="shadow-sm border-green-200 bg-green-50/30 dark:border-green-900/30 dark:bg-green-900/10"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><CheckCircle2 className="w-5 h-5 text-green-500 mb-1" /><span className="text-2xl font-black text-green-600 dark:text-green-400">{profile?.stats?.completed}</span><span className="text-[10px] font-bold text-green-800/70 dark:text-green-400/70 uppercase tracking-wider">Ready</span></CardContent></Card>
                <Card className="shadow-sm border-red-200 bg-red-50/30 dark:border-red-900/30 dark:bg-red-900/10"><CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1"><XCircle className="w-5 h-5 text-red-500 mb-1" /><span className="text-2xl font-black text-red-600 dark:text-red-400">{profile?.stats?.failed}</span><span className="text-[10px] font-bold text-red-800/70 dark:text-red-400/70 uppercase tracking-wider">Failed</span></CardContent></Card>
            </div>
        </div>

        {/* --- TROPHIES SECTION --- */}
        <div className="space-y-3">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <Trophy className="w-4 h-4" /> Achievements
            </h3>
            {profile?.trophies && profile.trophies.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {profile.trophies.map((trophy: any) => (
                        <Card key={trophy.id} className={`shadow-sm border-2 transition-all ${trophy.earned ? 'border-yellow-400 dark:border-yellow-500/50 bg-yellow-50/10 dark:bg-yellow-900/10 scale-105 z-10' : 'border-border opacity-60 grayscale hover:grayscale-0 hover:opacity-100'}`}>
                            <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-2">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center shadow-inner border ${trophy.earned ? 'bg-yellow-100 border-yellow-200 dark:bg-yellow-900/30 dark:border-yellow-700' : 'bg-muted border-border'}`}>
                                    {trophy.iconUrl ? <img src={trophy.iconUrl} alt={trophy.name} className="w-8 h-8 object-contain" /> : <Trophy className={`w-6 h-6 ${trophy.earned ? 'text-yellow-600 dark:text-yellow-500' : 'text-muted-foreground'}`} />}
                                </div>
                                <div>
                                    <h4 className="font-bold text-[11px] leading-tight text-foreground">{trophy.name}</h4>
                                    <p className="text-[9px] text-muted-foreground mt-0.5">{trophy.description}</p>
                                </div>
                                {trophy.earned && trophy.earnedAt && (
                                    <Badge variant="outline" className="text-[8px] uppercase tracking-wider border-yellow-200 dark:border-yellow-900/50 text-yellow-700 dark:text-yellow-500 bg-yellow-50 dark:bg-yellow-900/20 mt-1">
                                        {new Date(trophy.earnedAt).toLocaleDateString()}
                                    </Badge>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : (
                <Card className="shadow-sm bg-muted/30 border-dashed">
                    <CardContent className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center">
                        <Trophy className="w-8 h-8 mb-2 opacity-20" />
                        <p className="text-sm font-bold">No Trophies Available</p>
                        <p className="text-xs mt-1">Admins haven't added any achievements to earn yet!</p>
                    </CardContent>
                </Card>
            )}
        </div>

        <Card className="shadow-sm">
            <div className="p-6 border-b flex items-center justify-between">
                <div>
                    <h3 className="text-xl font-bold">Recent Request Activity</h3>
                    <p className="text-xs text-muted-foreground mt-1">Your latest requests and automated downloads.</p>
                </div>
                <Button variant="outline" size="sm" className="hidden sm:flex" asChild>
                    <Link href="/requests">View All Requests <ArrowRight className="w-4 h-4 ml-2"/></Link>
                </Button>
            </div>
            <CardContent className="p-0">
                <div className="divide-y">
                    {recentReqs.length === 0 ? (
                        <div className="p-10 text-center text-muted-foreground italic">No requests made yet.</div>
                    ) : (
                        recentReqs.map((req: any) => (
                            <ActivityCard key={req.id} req={req} getStatusBadge={getStatusBadge} />
                        ))
                    )}
                </div>
            </CardContent>
        </Card>
      </div>

      {/* 2FA SETUP MODAL */}
      <Dialog open={setup2faModalOpen} onOpenChange={setSetup2faModalOpen}>
          <DialogContent className="sm:max-w-[425px] rounded-xl">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary" /> Setup Two-Factor Auth</DialogTitle>
                  <DialogDescription>Use Google Authenticator, Authy, or Bitwarden to scan the code below.</DialogDescription>
              </DialogHeader>
              <div className="py-4 flex flex-col items-center space-y-6">
                  {qrCodeDataUrl ? (
                      <div className="bg-white p-4 rounded-xl shadow-inner border">
                          <img src={qrCodeDataUrl} alt="QR Code" className="w-48 h-48" />
                      </div>
                  ) : (
                      <div className="w-48 h-48 bg-muted rounded-xl flex items-center justify-center animate-pulse"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
                  )}

                  <div className="text-center space-y-1 w-full">
                      <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest">Manual Setup Key</p>
                      <code className="bg-muted px-3 py-1.5 rounded-md font-mono text-xs block w-full text-center border select-all">
                          {totpSecret || 'Loading...'}
                      </code>
                  </div>

                  <div className="w-full space-y-2">
                      <Label htmlFor="verifyCode" className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Verify Code</Label>
                      <Input 
                          id="verifyCode" 
                          type="text" 
                          inputMode="numeric" 
                          pattern="[0-9]*" 
                          maxLength={6} 
                          placeholder="Enter 6-digit code" 
                          value={verifyCode} 
                          onChange={(e) => setVerifyCode(e.target.value)} 
                          className="h-12 text-center text-2xl font-mono tracking-widest bg-muted" 
                      />
                  </div>
              </div>
              <DialogFooter>
                  <Button variant="outline" onClick={() => setSetup2faModalOpen(false)} disabled={isProcessing2fa}>Cancel</Button>
                  <Button onClick={handleVerifyAndEnable2FA} disabled={isProcessing2fa || verifyCode.length !== 6} className="bg-primary text-primary-foreground font-bold hover:bg-primary/90">
                      {isProcessing2fa ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Verify & Enable
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* 2FA DISABLE MODAL */}
      <Dialog open={disable2faModalOpen} onOpenChange={setDisable2faModalOpen}>
          <DialogContent className="sm:max-w-[425px] rounded-xl border-red-200 dark:border-red-900/50">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-red-600"><ShieldAlert className="w-5 h-5" /> Disable Two-Factor Auth?</DialogTitle>
                  <DialogDescription>Disabling 2FA will make your account less secure. Are you sure?</DialogDescription>
              </DialogHeader>
              <DialogFooter className="mt-4">
                  <Button variant="outline" onClick={() => setDisable2faModalOpen(false)} disabled={isProcessing2fa}>Cancel</Button>
                  <Button variant="destructive" onClick={handleDisable2FA} disabled={isProcessing2fa}>
                      {isProcessing2fa ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Yes, Disable 2FA"}
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* PASSWORD RESET MODAL */}
      <Dialog open={passwordModalOpen} onOpenChange={setPasswordModalOpen}>
          <DialogContent className="sm:max-w-[425px] rounded-xl">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><Key className="w-5 h-5 text-primary" /> Change Password</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                  <div className="space-y-2">
                      <Label>Current Password</Label>
                      <Input type="password" value={passwords.current} onChange={e => setPasswords({...passwords, current: e.target.value})} className="bg-muted" />
                  </div>
                  <div className="space-y-2">
                      <Label>New Password</Label>
                      <Input type="password" value={passwords.new} onChange={e => setPasswords({...passwords, new: e.target.value})} className="bg-muted" />
                      <p className="text-[10px] text-muted-foreground">Must be at least 12 characters.</p>
                  </div>
                  <div className="space-y-2">
                      <Label>Confirm New Password</Label>
                      <Input type="password" value={passwords.confirm} onChange={e => setPasswords({...passwords, confirm: e.target.value})} className="bg-muted" />
                  </div>
              </div>
              <DialogFooter>
                  <Button variant="outline" onClick={() => setPasswordModalOpen(false)} disabled={isProcessingSecurity}>Cancel</Button>
                  <Button onClick={handlePasswordChange} disabled={isProcessingSecurity || !passwords.current || !passwords.new} className="bg-primary text-primary-foreground">
                      {isProcessingSecurity ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Update Password
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* REVOKE SESSIONS MODAL */}
      <Dialog open={revokeModalOpen} onOpenChange={setRevokeModalOpen}>
          <DialogContent className="sm:max-w-[425px] rounded-xl border-orange-200 dark:border-orange-900/50">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-orange-600"><ShieldAlert className="w-5 h-5" /> Revoke All Sessions?</DialogTitle>
                  <DialogDescription>
                      This will immediately log you out of all other browsers, phones, and computers. Your current session will remain active.
                  </DialogDescription>
              </DialogHeader>
              <DialogFooter className="mt-4">
                  <Button variant="outline" onClick={() => setRevokeModalOpen(false)} disabled={isProcessingSecurity}>Cancel</Button>
                  <Button variant="destructive" className="bg-orange-600 hover:bg-orange-700" onClick={handleRevokeSessions} disabled={isProcessingSecurity}>
                      {isProcessingSecurity ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Yes, Sign Out Everywhere"}
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>

      {/* MANAGE API KEYS MODAL */}
      <Dialog open={manageKeysModalOpen} onOpenChange={(open) => {
          setManageKeysModalOpen(open);
          if (!open) setGeneratedKey(null);
      }}>
          <DialogContent className="sm:max-w-2xl w-[95%] rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
              <DialogHeader>
                  <DialogTitle className="flex items-center gap-2"><Smartphone className="w-5 h-5 text-primary" /> External App Access (OPDS)</DialogTitle>
                  <DialogDescription>
                      Create a personal API key to log into external reading apps. Use your Omnibus username and paste the generated API key as your password.
                  </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-6 py-4 overflow-y-auto pr-2">
                  <div className="flex flex-col sm:flex-row sm:items-end gap-3 w-full">
                      <div className="grid gap-2 flex-1 w-full min-w-0">
                          <Label>App Name / Device</Label>
                          <Input value={newKeyName} onChange={e => setNewKeyName(e.target.value)} placeholder="e.g., Panels on iPad" className="bg-muted border-border w-full" />
                      </div>
                      <Button onClick={handleGenerateKey} disabled={!newKeyName || isGeneratingKey} className="font-bold bg-primary hover:bg-primary/90 text-primary-foreground h-10 w-full sm:w-auto shrink-0">
                          {isGeneratingKey ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />} Generate Key
                      </Button>
                  </div>

                  {generatedKey && (
                      <div className="bg-green-50 border border-green-200 text-green-800 p-4 rounded-lg flex flex-col gap-2 relative dark:bg-green-900/20 dark:border-green-800 dark:text-green-400 animate-in fade-in slide-in-from-top-2 w-full">
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

                  <div className="border border-border rounded-lg overflow-x-auto w-full">
                      <table className="w-full text-sm text-left min-w-[500px]">
                          <thead className="bg-muted border-b border-border text-muted-foreground uppercase text-xs">
                              <tr>
                                  <th className="px-4 py-3">Device / App</th>
                                  <th className="px-4 py-3">Created</th>
                                  <th className="px-4 py-3">Last Used</th>
                                  <th className="px-4 py-3 text-right">Actions</th>
                              </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                              {apiKeys.length === 0 ? (
                                  <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground italic">You haven't generated any access keys.</td></tr>
                              ) : (
                                  apiKeys.map(key => (
                                      <tr key={key.id} className="hover:bg-muted/30">
                                          <td className="px-4 py-3 font-bold truncate max-w-[200px]">{key.name}</td>
                                          <td className="px-4 py-3 text-muted-foreground">{new Date(key.createdAt).toLocaleDateString()}</td>
                                          <td className="px-4 py-3 text-muted-foreground">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}</td>
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
              </div>
          </DialogContent>
      </Dialog>

    </div>
  )
}