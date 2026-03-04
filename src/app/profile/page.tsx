"use client"

import { useState, useEffect, useRef } from "react"
import { useSession } from "next-auth/react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"
import { useColorTheme } from "@/components/ThemeProvider"
import { 
  User as UserIcon, Upload, Loader2, ListOrdered, CheckCircle2, 
  Clock, XCircle, Activity, ArrowRight, Info, Calendar, BookOpen, Trophy, History, Palette, Check, ImageIcon, Trash2, ChevronLeft, ChevronRight
} from "lucide-react"

// --- Helper Component: Individual Activity Card ---
function ActivityCard({ req, getStatusBadge }: { req: any, getStatusBadge: (status: string) => JSX.Element }) {
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
    <div className="p-4 flex flex-col sm:flex-row gap-4 hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors">
        <div className="w-24 h-36 sm:w-28 sm:h-40 bg-slate-100 dark:bg-slate-800 rounded shadow-sm border dark:border-slate-700 overflow-hidden shrink-0">
            {req.imageUrl ? <img src={req.imageUrl} className="w-full h-full object-cover" alt="" /> : null}
        </div>
        <div className="min-w-0 flex-1 flex flex-col justify-between">
            <div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                    <p className="font-bold text-base truncate dark:text-slate-200" title={displayName}>{displayName}</p>
                    <div className="shrink-0">{getStatusBadge(req.status)}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={handleShowDesc} className="h-7 px-2 text-[11px] font-bold text-primary hover:text-primary/80 hover:bg-primary/10 -ml-2 mb-1">
                    <Info className="w-3 h-3 mr-1" /> {showDesc ? "Hide Synopsis" : "Read Synopsis"}
                </Button>
                {showDesc && (
                    <div className="text-xs text-muted-foreground leading-relaxed bg-slate-100 dark:bg-slate-900/80 p-3 rounded border dark:border-slate-800 mt-1 animate-in fade-in slide-in-from-top-1">
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

// --- Dynamic Banner Gradient Helper ---
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

export default function ProfilePage() {
  const { data: session, update } = useSession()
  const [profile, setProfile] = useState<any>(null)
  const [recentReqs, setRecentReqs] = useState<any[]>([])
  const [readingLists, setReadingLists] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  
  // Upload States & Refs
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const fileAvatarRef = useRef<HTMLInputElement>(null)
  const fileBannerRef = useRef<HTMLInputElement>(null)
  
  // History Pagination State
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

      const reqRes = await fetch('/api/admin/requests')
      if (reqRes.ok) {
        const data = await reqRes.json()
        const userRequests = data.filter((r: any) => r.userId === session.user.id);
        setRecentReqs(userRequests.slice(0, 5));
      }

      const listRes = await fetch('/api/reading-lists')
      if (listRes.ok) {
          setReadingLists(await listRes.json());
      }
    } catch (e) {
      toast({ title: "Error", description: "Failed to load profile data.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { 
      if (session?.user?.id) fetchData() 
  }, [session])

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        toast({ title: "File too large", description: "Avatar must be under 5MB.", variant: "destructive" });
        return;
    }
    setUploadingAvatar(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
        try {
            const res = await fetch('/api/user/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatarBase64: reader.result })
            });
            const data = await res.json();
            if (res.ok) {
                toast({ title: "Avatar Updated", description: "Your profile picture has been saved." });
                setProfile((prev: any) => ({ ...prev, user: { ...prev.user, avatar: data.avatarUrl } }));
                await update({ user: { image: data.avatarUrl } });
            } else { throw new Error(data.error); }
        } catch (err: any) {
            toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
        } finally { setUploadingAvatar(false); }
    };
    reader.readAsDataURL(file);
  }

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        toast({ title: "File too large", description: "Banner must be under 10MB.", variant: "destructive" });
        return;
    }
    setUploadingBanner(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
        try {
            const res = await fetch('/api/user/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bannerBase64: reader.result })
            });
            const data = await res.json();
            if (res.ok) {
                toast({ title: "Banner Updated", description: "Your profile banner has been saved." });
                setProfile((prev: any) => ({ ...prev, user: { ...prev.user, banner: data.bannerUrl } }));
            } else { throw new Error(data.error); }
        } catch (err: any) {
            toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
        } finally { setUploadingBanner(false); }
    };
    reader.readAsDataURL(file);
  }

  const handleRemoveBanner = async (e: React.MouseEvent) => {
    e.stopPropagation(); 
    setUploadingBanner(true);
    try {
        const res = await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ removeBanner: true })
        });
        if (res.ok) {
            toast({ title: "Banner Removed", description: "Your profile banner has been reset." });
            setProfile((prev: any) => ({ ...prev, user: { ...prev.user, banner: null } }));
        } else {
            const data = await res.json();
            throw new Error(data.error);
        }
    } catch (err: any) {
        toast({ title: "Failed to remove banner", description: err.message, variant: "destructive" });
    } finally {
        setUploadingBanner(false);
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'IMPORTED': case 'COMPLETED': return <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 text-[10px] uppercase font-bold">In Library</Badge>;
      case 'DOWNLOADING': return <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 text-[10px] uppercase font-bold">Downloading</Badge>;
      case 'PENDING_APPROVAL': return <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 text-[10px] uppercase font-bold text-center leading-tight">Needs Approval</Badge>;
      case 'FAILED': case 'STALLED': case 'ERROR': return <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 text-[10px] uppercase font-bold">Failed</Badge>;
      default: return <Badge variant="outline" className="bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-300 text-[10px] uppercase font-bold">Pending</Badge>;
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
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 pb-20 transition-colors duration-300">
      <title>Omnibus - Profile</title>
      
      {/* --- CUSTOMIZABLE BANNER --- */}
      <div className="relative h-48 sm:h-64 w-full group overflow-hidden bg-slate-900">
        {profile?.user?.banner ? (
            <img src={`/${profile.user.banner}`} alt="Banner" className="w-full h-full object-cover transition-all duration-300 group-hover:scale-105 group-hover:blur-sm opacity-90" />
        ) : (
            <div className={`absolute inset-0 bg-gradient-to-r ${getThemeGradient(colorTheme)} transition-all duration-300 group-hover:blur-sm`}>
                <div className="absolute inset-0 opacity-20 bg-[url('/images/omnibus-branding.jpg')] bg-cover mix-blend-overlay" />
            </div>
        )}
        
        {/* Banner Edit Overlay */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4 bg-black/30">
            {uploadingBanner ? <Loader2 className="w-8 h-8 animate-spin text-white" /> : (
                <>
                    <div 
                        className="text-center text-white flex flex-col items-center bg-black/60 px-6 py-4 rounded-xl backdrop-blur-md border border-white/10 shadow-2xl transition-transform hover:scale-105 cursor-pointer"
                        onClick={() => fileBannerRef.current?.click()}
                    >
                        <ImageIcon className="w-8 h-8 mb-2" />
                        <span className="font-black uppercase tracking-widest text-sm">Update Banner</span>
                        <span className="text-[11px] text-white/80 mt-1 font-medium bg-black/50 px-2 py-1 rounded">Recommended: 1920x400 (72 DPI)</span>
                    </div>
                    {profile?.user?.banner && (
                        <div 
                            className="text-center text-white flex flex-col items-center bg-red-600/80 px-6 py-4 rounded-xl backdrop-blur-md border border-red-500/50 shadow-2xl transition-transform hover:scale-105 cursor-pointer"
                            onClick={handleRemoveBanner}
                        >
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

      <div className="container mx-auto px-6 max-w-5xl relative -mt-20 sm:-mt-24 space-y-10">
        <div className="flex flex-col sm:flex-row items-center sm:items-end gap-6">
            
            {/* AVATAR EDIT */}
            <div className="relative group cursor-pointer" onClick={() => fileAvatarRef.current?.click()}>
                <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-full border-4 border-white dark:border-slate-950 bg-slate-200 dark:bg-slate-800 overflow-hidden flex items-center justify-center shadow-xl relative z-10 transition-transform group-hover:scale-105">
                    {uploadingAvatar ? <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /> : profile?.user?.avatar ? <img src={`/${profile.user.avatar}`} alt="Avatar" className="w-full h-full object-cover" /> : <UserIcon className="w-16 h-16 text-slate-400 dark:text-slate-600" />}
                </div>
                <div className="absolute inset-0 z-20 rounded-full bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white border-4 border-transparent">
                    <Upload className="w-6 h-6 mb-1" />
                    <span className="text-xs font-bold uppercase tracking-wider">Change</span>
                </div>
                <input type="file" ref={fileAvatarRef} className="hidden" accept="image/png, image/jpeg, image/webp" onChange={handleAvatarUpload} />
            </div>

            <div className="text-center sm:text-left mb-2 sm:mb-4 space-y-1 drop-shadow-md sm:drop-shadow-none">
                <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-slate-100 sm:text-white drop-shadow-lg">{profile?.user?.username}</h1>
                <div className="flex items-center justify-center sm:justify-start gap-2 bg-white/80 dark:bg-slate-950/80 sm:bg-transparent backdrop-blur-sm sm:backdrop-blur-none py-1 sm:py-0 px-3 sm:px-0 rounded-full w-fit mx-auto sm:mx-0">
                    <Badge className="bg-primary hover:bg-primary text-primary-foreground font-bold uppercase tracking-wider text-[10px]">{profile?.user?.role}</Badge>
                    <span className="text-xs text-muted-foreground sm:text-slate-200 font-medium sm:drop-shadow-md">Member since {new Date(profile?.user?.createdAt).getFullYear()}</span>
                </div>
            </div>
        </div>

        {/* CUSTOM THEME SELECTOR */}
        <div className="space-y-4 pt-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <Palette className="w-4 h-4" /> App Appearance
            </h3>
            <Card className="shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
                <CardContent className="p-6">
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                        {themes.map(t => (
                            <button 
                                key={t.id} 
                                onClick={() => setColorTheme(t.id)}
                                className={`flex flex-col items-center gap-3 p-3 rounded-xl border-2 transition-all ${colorTheme === t.id ? 'border-primary bg-primary/5' : 'border-transparent hover:border-slate-200 dark:hover:border-slate-700'}`}
                            >
                                <div className={`w-10 h-10 rounded-full shadow-sm flex items-center justify-center ${t.color}`}>
                                    {colorTheme === t.id && <Check className={`w-5 h-5 ${t.id === 'symbiote' ? 'text-white dark:text-black' : 'text-white'}`} />}
                                </div>
                                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{t.name}</span>
                            </button>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>

        {/* --- CURATED READING LISTS --- */}
        <div className="space-y-4">
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
                        <Card className="shadow-sm dark:border-slate-800 hover:border-primary dark:hover:border-primary transition-all h-full bg-white dark:bg-slate-900/50 hover:shadow-md">
                            <CardContent className="p-4 flex gap-4">
                                <div className="w-14 h-20 bg-slate-100 dark:bg-slate-800 rounded border dark:border-slate-700 overflow-hidden shrink-0 flex items-center justify-center">
                                    {list.coverUrl ? <img src={list.coverUrl} className="w-full h-full object-cover" alt="" /> : <ListOrdered className="w-6 h-6 text-slate-300" />}
                                </div>
                                <div className="flex flex-col justify-center">
                                    <h4 className="font-bold text-sm line-clamp-2 leading-tight dark:text-slate-200">{list.name}</h4>
                                    <p className="text-xs font-bold text-primary mt-1">{list.items?.length || 0} Issues</p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>
                ))}
                {readingLists.length === 0 && (
                    <div className="col-span-full p-8 text-center border-2 border-dashed rounded-xl border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
                        <ListOrdered className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
                        <p className="text-sm font-bold text-slate-700 dark:text-slate-300">No reading lists yet.</p>
                        <p className="text-xs text-muted-foreground mt-1 mb-4">Create curated events to read your comics in the perfect order!</p>
                        <Button variant="outline" size="sm" asChild>
                            <Link href="/reading-lists">Create an Event</Link>
                        </Button>
                    </div>
                )}
            </div>
            {readingLists.length > 0 && (
                <div className="sm:hidden pt-2">
                    <Button variant="outline" className="w-full dark:border-slate-700" asChild>
                        <Link href="/reading-lists">Manage Reading Lists</Link>
                    </Button>
                </div>
            )}
        </div>

        {/* --- RECENT READING HISTORY PAGINATED GRID --- */}
        {profile?.recentHistory && profile.recentHistory.length > 0 && (
            <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-1 mb-2">
                    <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                        <History className="w-4 h-4" /> Reading History
                    </h3>
                    
                    <div className="flex items-center justify-between sm:justify-end gap-3 w-full sm:w-auto">
                        <Button variant="ghost" size="sm" className="h-8 text-xs font-bold text-muted-foreground hover:text-foreground hidden sm:flex" asChild>
                            <Link href="/history">View Full History <ArrowRight className="w-3 h-3 ml-1.5" /></Link>
                        </Button>

                        {/* Pagination Controls matching ComicGrid */}
                        <div className="flex items-center gap-2 bg-white dark:bg-slate-900 p-1 rounded-md shadow-sm border dark:border-slate-800">
                            {/* @ts-ignore - match comic-grid size prop */}
                            <Button variant="ghost" size="icon-xs" className="h-7 w-7 p-0 dark:hover:bg-slate-800" onClick={() => setHistoryPage(p => Math.max(0, p - 1))} disabled={historyPage === 0}>
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-xs font-mono w-4 text-center">{historyPage + 1}</span>
                            {/* @ts-ignore */}
                            <Button variant="ghost" size="icon-xs" className="h-7 w-7 p-0 dark:hover:bg-slate-800" onClick={() => setHistoryPage(p => Math.min(totalHistoryPages - 1, p + 1))} disabled={historyPage >= totalHistoryPages - 1}>
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {displayedHistory.map((item: any) => {
                        const coverSource = item.coverUrl || (item.localCoverPath ? `/api/library/cover?path=${encodeURIComponent(item.localCoverPath)}` : null);

                        return (
                            <Link 
                                key={item.id} 
                                href={`/reader?path=${encodeURIComponent(item.filePath)}&series=${encodeURIComponent(item.folderPath)}`}
                                className="block group"
                            >
                                <Card className="shadow-sm dark:border-slate-800 bg-white dark:bg-slate-900/50 overflow-hidden group-hover:border-primary/50 transition-colors h-full">
                                    <CardContent className="p-4 flex items-center gap-4">
                                        <div className="w-14 h-20 bg-slate-100 dark:bg-slate-800 rounded shrink-0 border dark:border-slate-700 flex items-center justify-center overflow-hidden relative">
                                            {coverSource ? (
                                                <img 
                                                    src={coverSource} 
                                                    className="w-full h-full object-cover absolute inset-0 z-10" 
                                                    alt="" 
                                                    onError={(e) => { e.currentTarget.style.opacity = '0'; }} 
                                                />
                                            ) : null}
                                            <BookOpen className="w-5 h-5 text-slate-400 dark:text-slate-500 absolute z-0" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-bold text-sm truncate dark:text-slate-200 group-hover:text-primary transition-colors" title={item.seriesName}>{item.seriesName}</p>
                                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mt-0.5">Issue #{item.issueNumber}</p>
                                            <div className="mt-2.5 flex items-center gap-2">
                                                <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                                                    <div 
                                                        className={`h-full ${item.isCompleted ? 'bg-green-500' : 'bg-primary'}`} 
                                                        style={{ width: `${item.progress}%` }} 
                                                    />
                                                </div>
                                                <span className="text-[9px] font-black text-muted-foreground w-8 text-right">
                                                    {item.isCompleted ? 'DONE' : `${item.progress}%`}
                                                </span>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </Link>
                        );
                    })}
                </div>

                <div className="sm:hidden pt-2">
                    <Button variant="outline" className="w-full dark:border-slate-700 dark:hover:bg-slate-900" asChild>
                        <Link href="/history">View Full History</Link>
                    </Button>
                </div>
            </div>
        )}

        {/* Reading Progress Section with Bar */}
        <div className="space-y-4">
            <div className="px-1">
                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <BookOpen className="w-4 h-4" /> Overall Progress
                </h3>
            </div>
            
            <Card className="shadow-sm border-slate-200 dark:border-slate-800 dark:bg-slate-900/50 overflow-hidden">
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
                    
                    <div className="w-full h-3 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div 
                            className="h-full bg-primary transition-all duration-1000 ease-out"
                            style={{ width: `${profile?.stats?.completionRate || 0}%` }}
                        />
                    </div>
                </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-4">
                <Card className="shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <History className="w-5 h-5 text-primary mb-1" />
                        <span className="text-2xl font-black">{profile?.stats?.historyStarted || 0}</span>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Started</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <Trophy className="w-5 h-5 text-emerald-500 mb-1" />
                        <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{profile?.stats?.historyCompleted || 0}</span>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Finished</span>
                    </CardContent>
                </Card>
            </div>
        </div>

        <div className="space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <Upload className="w-4 h-4" /> Request Statistics
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <Card className="shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <ListOrdered className="w-5 h-5 text-slate-400 mb-1" />
                        <span className="text-2xl font-black">{profile?.stats?.total}</span>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Total</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm border-blue-200 bg-blue-50/30 dark:border-blue-900/30 dark:bg-blue-900/10">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <Activity className="w-5 h-5 text-blue-500 mb-1" />
                        <span className="text-2xl font-black text-blue-600 dark:text-blue-400">{profile?.stats?.active}</span>
                        <span className="text-[10px] font-bold text-blue-800/70 dark:text-blue-400/70 uppercase tracking-wider">Active</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm border-orange-200 bg-orange-50/30 dark:border-orange-900/30 dark:bg-orange-900/10">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <Clock className="w-5 h-5 text-orange-500 mb-1" />
                        <span className="text-2xl font-black text-orange-600 dark:text-orange-400">{profile?.stats?.pendingApproval}</span>
                        <span className="text-[10px] font-bold text-orange-800/70 dark:text-orange-400/70 uppercase tracking-wider">Pending</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm border-green-200 bg-green-50/30 dark:border-green-900/30 dark:bg-green-900/10">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <CheckCircle2 className="w-5 h-5 text-green-500 mb-1" />
                        <span className="text-2xl font-black text-green-600 dark:text-green-400">{profile?.stats?.completed}</span>
                        <span className="text-[10px] font-bold text-green-800/70 dark:text-green-400/70 uppercase tracking-wider">Ready</span>
                    </CardContent>
                </Card>
                <Card className="shadow-sm border-red-200 bg-red-50/30 dark:border-red-900/30 dark:bg-red-900/10">
                    <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-1">
                        <XCircle className="w-5 h-5 text-red-500 mb-1" />
                        <span className="text-2xl font-black text-red-600 dark:text-red-400">{profile?.stats?.failed}</span>
                        <span className="text-[10px] font-bold text-red-800/70 dark:text-red-400/70 uppercase tracking-wider">Failed</span>
                    </CardContent>
                </Card>
            </div>
        </div>

        {/* --- TROPHIES SECTION --- */}
        <div className="space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2 px-1">
                <Trophy className="w-4 h-4" /> Achievements
            </h3>
            {profile?.trophies && profile.trophies.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {profile.trophies.map((trophy: any) => (
                        <Card key={trophy.id} className={`shadow-sm border-2 transition-all ${trophy.earned ? 'border-yellow-400 dark:border-yellow-500/50 bg-yellow-50/10 dark:bg-yellow-900/10 scale-105 z-10' : 'border-slate-200 dark:border-slate-800 opacity-60 grayscale hover:grayscale-0 hover:opacity-100'}`}>
                            <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-2">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center shadow-inner border ${trophy.earned ? 'bg-yellow-100 border-yellow-200 dark:bg-yellow-900/30 dark:border-yellow-700' : 'bg-slate-100 border-slate-200 dark:bg-slate-800 dark:border-slate-700'}`}>
                                    {trophy.iconUrl ? (
                                        <img src={trophy.iconUrl} alt={trophy.name} className="w-8 h-8 object-contain" />
                                    ) : (
                                        <Trophy className={`w-6 h-6 ${trophy.earned ? 'text-yellow-600 dark:text-yellow-500' : 'text-slate-400'}`} />
                                    )}
                                </div>
                                <div>
                                    <h4 className="font-bold text-[11px] leading-tight dark:text-slate-200">{trophy.name}</h4>
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
                <Card className="shadow-sm dark:border-slate-800 dark:bg-slate-900/50 border-dashed">
                    <CardContent className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center">
                        <Trophy className="w-8 h-8 mb-2 opacity-20" />
                        <p className="text-sm font-bold">No Trophies Available</p>
                        <p className="text-xs mt-1">Admins haven't added any achievements to earn yet!</p>
                    </CardContent>
                </Card>
            )}
        </div>

        <Card className="shadow-sm dark:border-slate-800">
            <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between">
                <div>
                    <h3 className="text-xl font-bold dark:text-slate-100">Recent Request Activity</h3>
                    <p className="text-xs text-muted-foreground mt-1">Your latest requests and automated downloads.</p>
                </div>
                <Button variant="outline" size="sm" className="hidden sm:flex dark:border-slate-700 dark:hover:bg-slate-900" asChild>
                    <Link href="/requests">View All Requests <ArrowRight className="w-4 h-4 ml-2"/></Link>
                </Button>
            </div>
            <CardContent className="p-0">
                <div className="divide-y dark:divide-slate-800">
                    {recentReqs.length === 0 ? (
                        <div className="p-10 text-center text-muted-foreground italic">No requests made yet.</div>
                    ) : (
                        recentReqs.map((req: any) => (
                            <ActivityCard key={req.id} req={req} getStatusBadge={getStatusBadge} />
                        ))
                    )}
                </div>
                <div className="p-4 border-t dark:border-slate-800 sm:hidden">
                    <Button variant="outline" className="w-full dark:border-slate-700 dark:hover:bg-slate-900" asChild>
                        <Link href="/requests">View All Requests</Link>
                    </Button>
                </div>
            </CardContent>
        </Card>
      </div>
    </div>
  )
}