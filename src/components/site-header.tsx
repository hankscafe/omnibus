"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useSession, signOut } from "next-auth/react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { 
  ShieldAlert, LogOut, User as UserIcon, Sun, Moon, Key, Loader2, 
  Bell, Check, Image as ImageIcon, Trophy, Wrench, Menu
} from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { OmnibusLogo } from "@/components/omnibus-logo"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"

// --- INTERNAL NOTIFICATION COMPONENT ---
function NotificationBell() {
  const [notifications, setNotifications] = useState<any[]>([])
  const [open, setOpen] = useState(false)

  const fetchNotifications = async () => {
    try {
      const res = await fetch('/api/notifications')
      if (res.ok) setNotifications(await res.json())
    } catch (e) { console.error("Notification fetch failed", e) }
  }

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 60000) // Poll every minute
    return () => clearInterval(interval)
  }, [])

  const markAllAsRead = async () => {
    const comicIds = notifications.filter(n => n.type === 'comic').map(n => n.id);
    const trophyIds = notifications.filter(n => n.type === 'trophy').map(n => n.id);
    const reportIds = notifications.filter(n => n.type === 'report').map(n => n.id);

    if (comicIds.length === 0 && trophyIds.length === 0 && reportIds.length === 0) return;

    try {
      const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestIds: comicIds, trophyIds, reportIds })
      })
      if (res.ok) {
        setNotifications([])
        setOpen(false)
      }
    } catch (e) { console.error("Failed to clear notifications", e) }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-10 w-10 sm:h-9 sm:w-9">
          <Bell className="h-6 w-6 sm:h-5 sm:w-5 text-muted-foreground hover:text-foreground transition-colors" />
          {notifications.length > 0 && (
            <span className="absolute top-1.5 right-1.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600 border-2 border-background"></span>
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[95vw] sm:w-80 p-0 dark:bg-slate-950 dark:border-slate-800 shadow-2xl rounded-xl sm:rounded-md mt-2 sm:mt-0">
        <div className="p-4 border-b dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/50 rounded-t-xl sm:rounded-t-md">
          <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Recent Activity</h4>
          {notifications.length > 0 && (
            <Button variant="ghost" size="sm" className="h-8 px-3 text-xs sm:text-[10px] font-black uppercase text-blue-600 hover:text-blue-700" onClick={markAllAsRead}>
              Clear
            </Button>
          )}
        </div>
        <div className="max-h-[50vh] sm:max-h-[350px] overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="p-10 text-center flex flex-col items-center gap-2">
              <Bell className="h-8 w-8 text-slate-200 dark:text-slate-800" />
              <p className="text-sm sm:text-xs text-muted-foreground font-medium italic">Your inbox is empty.</p>
            </div>
          ) : (
            notifications.map((n) => (
              <DropdownMenuItem key={`${n.type}-${n.id}`} className="p-0 focus:bg-transparent">
                <Link href={n.type === 'trophy' ? "/profile" : "/library"} className="w-full p-4 border-b last:border-0 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors flex gap-3 items-center">
                  
                  {n.type === 'comic' ? (
                      <div className="h-16 w-11 sm:h-14 sm:w-10 shrink-0 bg-slate-100 dark:bg-slate-800 rounded shadow-inner overflow-hidden border dark:border-slate-700 flex items-center justify-center">
                        {n.imageUrl ? <img src={n.imageUrl} alt="" className="object-cover h-full w-full" /> : <ImageIcon className="h-5 w-5 sm:h-4 sm:w-4 text-slate-300" />}
                      </div>
                  ) : n.type === 'trophy' ? (
                      <div className="h-12 w-12 shrink-0 bg-yellow-100 dark:bg-yellow-900/30 rounded-full shadow-inner overflow-hidden border border-yellow-400 dark:border-yellow-500/50 flex items-center justify-center">
                        {n.imageUrl ? <img src={n.imageUrl} alt="" className="object-contain h-8 w-8" /> : <Trophy className="h-6 w-6 text-yellow-600 dark:text-yellow-500" />}
                      </div>
                  ) : (
                      // Report UI
                      <div className="h-12 w-12 shrink-0 bg-red-100 dark:bg-red-900/30 rounded-full shadow-inner overflow-hidden border border-red-400 dark:border-red-500/50 flex items-center justify-center">
                        <Wrench className="h-6 w-6 text-red-600 dark:text-red-500" />
                      </div>
                  )}
                  
                  <div className="flex-1 min-w-0">
                    <p className="text-sm sm:text-xs font-black leading-tight line-clamp-2 dark:text-slate-100 mb-1 uppercase tracking-tight">
                      {n.type === 'trophy' ? `Trophy Unlocked: ${n.title}` : (n.title || 'Requested Issue')}
                    </p>
                    
                    {n.type === 'report' && (
                        <p className="text-[11px] sm:text-[10px] text-muted-foreground line-clamp-1 italic mb-1 border-l-2 border-slate-300 dark:border-slate-700 pl-1">{n.description}</p>
                    )}

                    {n.type === 'comic' ? (
                        <div className="flex items-center gap-1.5"><div className="h-1.5 w-1.5 rounded-full bg-green-500" /><span className="text-[11px] sm:text-[10px] font-black uppercase text-green-600 tracking-widest">Available Now</span></div>
                    ) : n.type === 'trophy' ? (
                        <div className="flex items-center gap-1.5"><Trophy className="h-3.5 w-3.5 sm:h-3 sm:w-3 text-yellow-500" /><span className="text-[11px] sm:text-[10px] font-black uppercase text-yellow-600 tracking-widest">Achievement</span></div>
                    ) : (
                        <div className="flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5 sm:h-3 sm:w-3 text-red-500" /><span className="text-[11px] sm:text-[10px] font-black uppercase text-red-600 tracking-widest">Admin Reply</span></div>
                    )}
                  </div>
                </Link>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SiteHeader() {
  const { data: session, status } = useSession()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const { toast } = useToast()
  
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const [passModalOpen, setPassModalOpen] = useState(false)
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" })
  const [passLoading, setPassLoading] = useState(false)

  useEffect(() => {
    if ((session as any)?.error === "SessionExpired") {
      toast({ 
        title: "Session Expired", 
        description: "You have been logged out due to inactivity.", 
        variant: "destructive" 
      });
      signOut({ redirect: false }).then(() => {
        window.location.href = '/login';
      });
    }
  }, [session, toast]);

  const handleChangePassword = async (e: React.FormEvent) => {
      e.preventDefault();
      if (passwords.new !== passwords.confirm) {
          toast({ title: "Error", description: "New passwords do not match.", variant: "destructive" });
          return;
      }
      setPassLoading(true);
      try {
          const res = await fetch('/api/user/change-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ currentPassword: passwords.current, newPassword: passwords.new })
          });
          const data = await res.json();
          if (res.ok) {
              toast({ title: "Success", description: data.message });
              setPassModalOpen(false);
              setPasswords({ current: "", new: "", confirm: "" });
          } else {
              toast({ title: "Failed", description: data.error, variant: "destructive" });
          }
      } catch (e) {
          toast({ title: "Error", description: "Failed to connect to server.", variant: "destructive" });
      } finally {
          setPassLoading(false);
      }
  }

  const isDark = resolvedTheme === "dark";

  return (
    <header 
      suppressHydrationWarning 
      className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm"
    >
      <div className="container mx-auto flex h-16 items-center justify-between px-4 sm:px-6">
        
        <div className="flex gap-2 sm:gap-6 items-center">
          
          {/* MOBILE HAMBURGER MENU */}
          {!mounted ? (
             <div className="md:hidden w-10 h-10 shrink-0" />
          ) : session ? (
            <div className="md:hidden flex items-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0">
                    <Menu className="h-6 w-6 text-slate-700 dark:text-slate-300" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 mt-2 p-2 dark:bg-slate-950 dark:border-slate-800 shadow-xl rounded-xl z-50">
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg dark:hover:bg-slate-900">
                    <Link href="/">Home</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg dark:hover:bg-slate-900">
                    <Link href="/library">Library</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg dark:hover:bg-slate-900">
                    <Link href="/reading-lists">Reading Lists</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg dark:hover:bg-slate-900">
                    <Link href="/requests">My Requests</Link>
                  </DropdownMenuItem>
                  {session?.user?.role === "ADMIN" && (
                    <>
                      <DropdownMenuSeparator className="dark:bg-slate-800 my-1" />
                      <DropdownMenuItem asChild className="p-3 text-base font-bold cursor-pointer rounded-lg text-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/20">
                        <Link href="/admin"><ShieldAlert className="w-5 h-5 mr-3" /> Admin Dashboard</Link>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          <Link href="/" className="flex items-center transition-transform hover:scale-[1.02] text-slate-900 dark:text-slate-100">
            <OmnibusLogo className="w-36 sm:w-56 h-auto shrink-0" />
          </Link>
          
          {/* DESKTOP NAV */}
          <nav className="hidden md:flex gap-6 ml-4 items-center">
            <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Home</Link>
            <Link href="/library" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Library</Link>
            <Link href="/reading-lists" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Reading Lists</Link>
            <Link href="/requests" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">My Requests</Link>
            
            {session?.user?.role === "ADMIN" && (
                <Button variant="outline" size="sm" className="h-8 gap-1.5 border-blue-200 bg-blue-50/50 text-blue-600 hover:bg-blue-100 hover:text-blue-700 dark:border-blue-900 dark:bg-blue-900/20 dark:hover:bg-blue-900/40" asChild>
                  <Link href="/admin"><ShieldAlert className="w-3.5 h-3.5" /> Admin</Link>
                </Button>
            )}
          </nav>
        </div>

        {/* RIGHT SIDE ICONS */}
        <div className="flex items-center gap-1 sm:gap-4">
          {!mounted ? (
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="hidden sm:block w-14 h-7 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse" />
              <div className="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-800 animate-pulse ml-1" />
            </div>
          ) : (
            <>
              {session && <NotificationBell />}

              <button
                onClick={() => setTheme(isDark ? "light" : "dark")}
                className={`relative flex items-center w-14 h-7 rounded-full p-1 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 shadow-inner hidden sm:flex ${
                  isDark ? "bg-slate-800 border border-slate-700" : "bg-slate-200 border border-slate-300"
                }`}
                aria-label="Toggle Dark Mode"
              >
                <div 
                  className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-300 ease-in-out ${
                    isDark ? "translate-x-7 bg-slate-950" : "translate-x-0 bg-white"
                  }`} 
                />
                <div className="relative z-10 flex justify-between w-full px-0.5 pointer-events-none">
                  <Sun className={`w-3.5 h-3.5 transition-colors ${isDark ? "text-slate-500" : "text-amber-500"}`} />
                  <Moon className={`w-3.5 h-3.5 transition-colors ${isDark ? "text-blue-400" : "text-slate-400"}`} />
                </div>
              </button>

              {status === "loading" ? (
                 <div className="w-10 h-10 bg-muted animate-pulse rounded-full ml-1" />
              ) : session ? (
                 <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="relative h-10 w-10 sm:h-10 sm:w-10 rounded-full bg-slate-100 dark:bg-slate-800 border-2 dark:border-slate-700 overflow-hidden p-0 ml-1">
                            {session.user?.image ? (
                              <img 
                                src={session.user.image.startsWith('/') || session.user.image.startsWith('http') ? session.user.image : `/${session.user.image}`} 
                                alt="Avatar" 
                                className="w-full h-full object-cover" 
                              />
                              ) : (
                                <UserIcon className="w-5 h-5 sm:w-5 sm:h-5 text-slate-600 dark:text-slate-300" />
                            )}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64 sm:w-56 mt-2 sm:mt-0 p-2 sm:p-1 dark:bg-slate-950 dark:border-slate-800 rounded-xl sm:rounded-md shadow-xl">
                        <DropdownMenuLabel className="font-normal p-3 sm:p-2">
                            <div className="flex flex-col space-y-1">
                                <p className="text-base sm:text-sm font-bold leading-none">{session.user?.name}</p>
                                <p className="text-xs sm:text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{session.user?.role}</p>
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator className="dark:bg-slate-800" />
                        
                        <div className="sm:hidden p-3 flex items-center justify-between">
                          <span className="text-sm font-medium">Dark Mode</span>
                          <Switch checked={isDark} onCheckedChange={(c) => setTheme(c ? "dark" : "light")} />
                        </div>
                        <DropdownMenuSeparator className="dark:bg-slate-800 sm:hidden" />

                        <DropdownMenuItem asChild className="p-3 sm:p-2 text-base sm:text-sm cursor-pointer rounded-lg sm:rounded-sm dark:hover:bg-slate-900">
                            <Link href="/profile"><UserIcon className="w-5 h-5 sm:w-4 sm:h-4 mr-3 sm:mr-2" /> Profile</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem className="p-3 sm:p-2 text-base sm:text-sm cursor-pointer rounded-lg sm:rounded-sm dark:hover:bg-slate-900" onClick={() => setPassModalOpen(true)}>
                            <Key className="w-5 h-5 sm:w-4 sm:h-4 mr-3 sm:mr-2" /> Change Password
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="dark:bg-slate-800 my-1" />
                        
                        <DropdownMenuItem 
                          className="p-3 sm:p-2 text-base sm:text-sm cursor-pointer rounded-lg sm:rounded-sm text-red-600 focus:text-red-700 focus:bg-red-50 dark:text-red-400 dark:focus:bg-red-900/20" 
                          onClick={(e) => {
                            e.preventDefault();
                            signOut({ redirect: false }).then(() => {
                              window.location.href = '/login';
                            });
                          }}
                        >
                            <LogOut className="w-5 h-5 sm:w-4 sm:h-4 mr-3 sm:mr-2" /> Log Out
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                 </DropdownMenu>
              ) : (
                 <Button size="sm" asChild className="h-9 font-bold ml-2"><Link href="/login">Sign In</Link></Button>
              )}
            </>
          )}
        </div>
      </div>

      <Dialog open={passModalOpen} onOpenChange={setPassModalOpen}>
        <DialogContent className="sm:max-w-md w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
            <DialogHeader>
                <DialogTitle>Change Password</DialogTitle>
                <DialogDescription>Ensure your account remains secure. You will not be logged out.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleChangePassword} className="space-y-4 py-4">
                <div className="space-y-2">
                    <Label>Current Password</Label>
                    <Input type="password" value={passwords.current} onChange={e => setPasswords({...passwords, current: e.target.value})} className="h-12 sm:h-10 dark:bg-slate-900 dark:border-slate-800" required />
                </div>
                <div className="space-y-2">
                    <Label>New Password</Label>
                    <Input type="password" value={passwords.new} onChange={e => setPasswords({...passwords, new: e.target.value})} className="h-12 sm:h-10 dark:bg-slate-900 dark:border-slate-800" required />
                    <p className="text-[10px] text-muted-foreground">Min 12 characters. Must include uppercase, lowercase, number, and symbol.</p>
                </div>
                <div className="space-y-2">
                    <Label>Confirm New Password</Label>
                    <Input type="password" value={passwords.confirm} onChange={e => setPasswords({...passwords, confirm: e.target.value})} className="h-12 sm:h-10 dark:bg-slate-900 dark:border-slate-800" required />
                </div>
                <DialogFooter className="pt-4 gap-2 sm:gap-0">
                    <Button type="button" variant="outline" className="h-12 sm:h-10" onClick={() => setPassModalOpen(false)}>Cancel</Button>
                    <Button type="submit" className="h-12 sm:h-10 bg-blue-600 hover:bg-blue-700 text-white font-bold" disabled={passLoading}>
                        {passLoading ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2"/> : <Key className="w-5 h-5 sm:w-4 sm:h-4 mr-2"/>} Update Password
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
      </Dialog>
    </header>
  )
}