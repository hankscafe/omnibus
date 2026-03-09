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
    const interval = setInterval(fetchNotifications, 60000) 
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
        <Button variant="ghost" size="icon" className="relative h-10 w-10 sm:h-9 sm:w-9 group hover:bg-primary/10 transition-colors">
          <Bell className="h-6 w-6 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
          {notifications.length > 0 && (
            <span className="absolute top-1.5 right-1.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-600 border-2 border-background"></span>
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[95vw] sm:w-80 p-0 bg-popover border-border shadow-2xl rounded-xl sm:rounded-md mt-2 sm:mt-0">
        <div className="p-4 border-b border-border flex justify-between items-center bg-muted/50 rounded-t-xl sm:rounded-t-md">
          <h4 className="font-black text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Recent Activity</h4>
          {notifications.length > 0 && (
            <Button variant="ghost" size="sm" className="h-8 px-3 text-xs sm:text-[10px] font-black uppercase text-primary hover:text-primary/80 hover:bg-primary/10" onClick={markAllAsRead}>
              Clear
            </Button>
          )}
        </div>
        <div className="max-h-[50vh] sm:max-h-[350px] overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="p-10 text-center flex flex-col items-center gap-2">
              <Bell className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm sm:text-xs text-muted-foreground font-medium italic">Your inbox is empty.</p>
            </div>
          ) : (
            notifications.map((n) => (
              <DropdownMenuItem key={`${n.type}-${n.id}`} className="p-0 focus:bg-transparent">
                <Link href={n.type === 'trophy' ? "/profile" : "/library"} className="w-full p-4 border-b last:border-0 border-border hover:bg-muted/50 transition-colors flex gap-3 items-center">
                  
                  {n.type === 'comic' ? (
                      <div className="h-16 w-11 sm:h-14 sm:w-10 shrink-0 bg-muted rounded shadow-inner overflow-hidden border border-border flex items-center justify-center">
                        {n.imageUrl ? <img src={n.imageUrl} alt="" className="object-cover h-full w-full" /> : <ImageIcon className="h-5 w-5 sm:h-4 sm:w-4 text-muted-foreground/50" />}
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
                    <p className="text-sm sm:text-xs font-black leading-tight line-clamp-2 text-foreground mb-1 uppercase tracking-tight">
                      {n.type === 'trophy' ? `Trophy Unlocked: ${n.title}` : (n.title || 'Requested Issue')}
                    </p>
                    
                    {n.type === 'report' && (
                        <p className="text-[11px] sm:text-[10px] text-muted-foreground line-clamp-1 italic mb-1 border-l-2 border-muted pl-1">{n.description}</p>
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
      className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm transition-colors duration-300"
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
                    <Menu className="h-6 w-6 text-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 mt-2 p-2 bg-popover border-border shadow-xl rounded-xl z-50">
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg hover:bg-muted focus:bg-primary/10 focus:text-primary transition-colors">
                    <Link href="/">Home</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg hover:bg-muted focus:bg-primary/10 focus:text-primary transition-colors">
                    <Link href="/library">Library</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg hover:bg-muted focus:bg-primary/10 focus:text-primary transition-colors">
                    <Link href="/reading-lists">Reading Lists</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild className="p-3 text-base font-medium cursor-pointer rounded-lg hover:bg-muted focus:bg-primary/10 focus:text-primary transition-colors">
                    <Link href="/requests">My Requests</Link>
                  </DropdownMenuItem>
                  {session?.user?.role === "ADMIN" && (
                    <>
                      <DropdownMenuSeparator className="bg-border my-1" />
                      <DropdownMenuItem asChild className="p-3 text-base font-bold cursor-pointer rounded-lg text-primary hover:bg-primary/10 focus:bg-primary/20 focus:text-primary transition-colors">
                        <Link href="/admin"><ShieldAlert className="w-5 h-5 mr-3" /> Admin Dashboard</Link>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          <Link href="/" className="flex items-center transition-transform hover:scale-[1.02] text-foreground">
            <OmnibusLogo className="w-36 sm:w-56 h-auto shrink-0" />
          </Link>
          
          {/* DESKTOP NAV */}
          <nav className="hidden md:flex gap-6 ml-4 items-center">
            <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Home</Link>
            <Link href="/library" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Library</Link>
            <Link href="/reading-lists" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Reading Lists</Link>
            <Link href="/requests" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">My Requests</Link>
            
            {session?.user?.role === "ADMIN" && (
                <Button variant="outline" size="sm" className="h-8 gap-1.5 border-primary/20 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary transition-colors" asChild>
                  <Link href="/admin"><ShieldAlert className="w-3.5 h-3.5" /> Admin</Link>
                </Button>
            )}
          </nav>
        </div>

        {/* RIGHT SIDE ICONS */}
        <div className="flex items-center gap-1 sm:gap-4">
          {!mounted ? (
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="hidden sm:block w-14 h-7 rounded-full bg-muted animate-pulse" />
              <div className="w-10 h-10 rounded-full bg-muted animate-pulse ml-1" />
            </div>
          ) : (
            <>
              {session && <NotificationBell />}

              <button
                onClick={() => setTheme(isDark ? "light" : "dark")}
                className={`relative flex items-center w-14 h-7 rounded-full p-1 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 shadow-inner hidden sm:flex bg-muted border border-border hover:border-primary/50`}
                aria-label="Toggle Dark Mode"
              >
                <div 
                  className={`absolute w-5 h-5 rounded-full shadow-md transition-transform duration-300 ease-in-out ${
                    isDark ? "translate-x-7 bg-background" : "translate-x-0 bg-background"
                  }`} 
                />
                <div className="relative z-10 flex justify-between w-full px-0.5 pointer-events-none">
                  <Sun className={`w-3.5 h-3.5 transition-colors ${isDark ? "text-muted-foreground" : "text-primary"}`} />
                  <Moon className={`w-3.5 h-3.5 transition-colors ${isDark ? "text-primary" : "text-muted-foreground"}`} />
                </div>
              </button>

              {status === "loading" ? (
                 <div className="w-10 h-10 bg-muted animate-pulse rounded-full ml-1" />
              ) : session ? (
                 <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="relative h-10 w-10 sm:h-10 sm:w-10 rounded-full bg-muted border-2 border-border hover:border-primary/50 overflow-hidden p-0 ml-1 transition-colors">
                            {session.user?.image ? (
                              <img 
                                src={session.user.image.startsWith('/') || session.user.image.startsWith('http') ? session.user.image : `/${session.user.image}`} 
                                alt="Avatar" 
                                className="w-full h-full object-cover" 
                              />
                              ) : (
                                <UserIcon className="w-5 h-5 sm:w-5 sm:h-5 text-foreground" />
                            )}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64 sm:w-56 mt-2 sm:mt-0 p-2 sm:p-1 bg-popover border-border rounded-xl sm:rounded-md shadow-xl">
                        <DropdownMenuLabel className="font-normal p-3 sm:p-2">
                            <div className="flex flex-col space-y-1">
                                <p className="text-base sm:text-sm font-bold leading-none">{session.user?.name}</p>
                                <p className="text-xs sm:text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{session.user?.role}</p>
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator className="bg-border" />
                        
                        <div className="sm:hidden p-3 flex items-center justify-between">
                          <span className="text-sm font-medium">Dark Mode</span>
                          <Switch checked={isDark} onCheckedChange={(c) => setTheme(c ? "dark" : "light")} />
                        </div>
                        <DropdownMenuSeparator className="bg-border sm:hidden" />

                        <DropdownMenuItem asChild className="p-3 sm:p-2 text-base sm:text-sm cursor-pointer rounded-lg sm:rounded-sm hover:bg-muted focus:bg-primary/10 focus:text-primary transition-colors">
                            <Link href="/profile"><UserIcon className="w-5 h-5 sm:w-4 sm:h-4 mr-3 sm:mr-2" /> Profile</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem className="p-3 sm:p-2 text-base sm:text-sm cursor-pointer rounded-lg sm:rounded-sm hover:bg-muted focus:bg-primary/10 focus:text-primary transition-colors" onClick={() => setPassModalOpen(true)}>
                            <Key className="w-5 h-5 sm:w-4 sm:h-4 mr-3 sm:mr-2" /> Change Password
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border my-1" />
                        
                        <DropdownMenuItem 
                          className="p-3 sm:p-2 text-base sm:text-sm cursor-pointer rounded-lg sm:rounded-sm text-red-600 focus:text-red-700 focus:bg-red-50 dark:text-red-400 dark:focus:bg-red-900/20 transition-colors" 
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
                 <Button size="sm" asChild className="h-9 font-bold ml-2 bg-primary hover:bg-primary/90 text-primary-foreground"><Link href="/login">Sign In</Link></Button>
              )}
            </>
          )}
        </div>
      </div>

      <Dialog open={passModalOpen} onOpenChange={setPassModalOpen}>
        <DialogContent className="sm:max-w-md w-[95%] bg-background border-border rounded-xl">
            <DialogHeader>
                <DialogTitle>Change Password</DialogTitle>
                <DialogDescription>Ensure your account remains secure. You will not be logged out.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleChangePassword} className="space-y-4 py-4">
                <div className="space-y-2">
                    <Label>Current Password</Label>
                    <Input type="password" value={passwords.current} onChange={e => setPasswords({...passwords, current: e.target.value})} className="h-12 sm:h-10 bg-muted border-border" required />
                </div>
                <div className="space-y-2">
                    <Label>New Password</Label>
                    <Input type="password" value={passwords.new} onChange={e => setPasswords({...passwords, new: e.target.value})} className="h-12 sm:h-10 bg-muted border-border" required />
                    <p className="text-[10px] text-muted-foreground">Min 12 characters. Must include uppercase, lowercase, number, and symbol.</p>
                </div>
                <div className="space-y-2">
                    <Label>Confirm New Password</Label>
                    <Input type="password" value={passwords.confirm} onChange={e => setPasswords({...passwords, confirm: e.target.value})} className="h-12 sm:h-10 bg-muted border-border" required />
                </div>
                <DialogFooter className="pt-4 gap-2 sm:gap-0">
                    <Button type="button" variant="outline" className="h-12 sm:h-10 border-border hover:bg-muted text-foreground" onClick={() => setPassModalOpen(false)}>Cancel</Button>
                    <Button type="submit" className="h-12 sm:h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold" disabled={passLoading}>
                        {passLoading ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2"/> : <Key className="w-5 h-5 sm:w-4 sm:h-4 mr-2"/>} Update Password
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
      </Dialog>
    </header>
  )
}