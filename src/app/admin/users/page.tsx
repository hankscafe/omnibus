"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Loader2, User as UserIcon, Trash2, Plus, Eye, Shield, DownloadCloud, Activity, ShieldOff } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"

export default function AdminUsersPage() {
  useEffect(() => {
      document.title = "Omnibus - Users";
  }, []);

  const { data: session } = useSession()
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [userToDelete, setUserToDelete] = useState<{ id: string, username: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // 2FA Reset States
  const [reset2faConfirmOpen, setReset2faConfirmOpen] = useState(false)
  const [userToReset, setUserToReset] = useState<{ id: string, username: string } | null>(null)
  const [isResetting2fa, setIsResetting2fa] = useState(false)

  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [newUser, setNewUser] = useState({
      username: '', email: '', password: '', role: 'USER',
      isApproved: true, autoApproveRequests: false, canDownload: false
  })
  
  const { toast } = useToast()

  const fetchUsers = async () => {
    try {
      const res = await fetch('/api/admin/users')
      if (res.ok) setUsers(await res.json())
    } catch (e) {
      toast({ title: "Error", description: "Failed to load users.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchUsers() }, [])

  const handleUpdateUser = async (id: string, field: string, value: any) => {
    setUpdating(id)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, [field]: value })
      })
      if (res.ok) {
        toast({ title: "User Updated", description: "Changes saved successfully." })
        setUsers(prev => prev.map(u => u.id === id ? { ...u, [field]: value } : u))
      } else throw new Error("Update failed")
    } catch (error: any) {
      toast({ title: "Update Failed", description: error.message, variant: "destructive" })
    } finally {
      setUpdating(null)
    }
  }

  const handleImpersonate = async (userId: string, username: string) => {
      toast({ title: "Switching Accounts...", description: `Logging in as ${username}` });
      try {
          const res = await fetch('/api/admin/impersonate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, action: 'start' })
          });
          if (res.ok) {
              window.location.href = '/'; 
          } else throw new Error("Failed to start impersonation");
      } catch (error: any) {
          toast({ title: "Error", description: error.message, variant: "destructive" });
      }
  }

  const initiateDelete = (id: string, username: string) => {
    setUserToDelete({ id, username });
    setDeleteConfirmOpen(true);
  }

  const handleConfirmedDelete = async () => {
    if (!userToDelete) return;
    setIsDeleting(true);
    try {
        const res = await fetch(`/api/admin/users?id=${userToDelete.id}`, { method: 'DELETE' });
        if (res.ok) {
            toast({ title: "User Deleted" });
            setUsers(prev => prev.filter(u => u.id !== userToDelete.id));
            setDeleteConfirmOpen(false);
        } else throw new Error("Failed to delete user");
    } catch (error: any) {
        toast({ title: "Delete Failed", description: error.message, variant: "destructive" });
    } finally {
        setIsDeleting(false);
        setUserToDelete(null);
    }
  }

  // --- NEW: 2FA Reset Methods ---
  const initiateReset2FA = (id: string, username: string) => {
    setUserToReset({ id, username });
    setReset2faConfirmOpen(true);
  }

  const handleConfirmedReset2FA = async () => {
    if (!userToReset) return;
    setIsResetting2fa(true);
    try {
        const res = await fetch('/api/admin/users', { 
            method: 'PATCH', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: userToReset.id, reset2FA: true })
        });
        if (res.ok) {
            toast({ title: "2FA Reset", description: `Two-Factor Authentication disabled for ${userToReset.username}.` });
            setUsers(prev => prev.map(u => u.id === userToReset.id ? { ...u, twoFactorEnabled: false } : u));
            setReset2faConfirmOpen(false);
        } else throw new Error("Failed to reset 2FA");
    } catch (error: any) {
        toast({ title: "Reset Failed", description: error.message, variant: "destructive" });
    } finally {
        setIsResetting2fa(false);
        setUserToReset(null);
    }
  }

  const handleCreateUser = async () => {
      if (!newUser.username || !newUser.email || !newUser.password) {
          toast({ title: "Missing Fields", variant: "destructive" });
          return;
      }
      setIsCreating(true);
      try {
          const res = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newUser) });
          if (res.ok) {
              toast({ title: "User Created", description: `${newUser.username} has been added.` });
              setCreateModalOpen(false);
              setNewUser({ username: '', email: '', password: '', role: 'USER', isApproved: true, autoApproveRequests: false, canDownload: false });
              fetchUsers();
          } else throw new Error("Failed to create user");
      } catch (error: any) {
          toast({ title: "Creation Failed", description: error.message, variant: "destructive" });
      } finally { setIsCreating(false); }
  }

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>

  return (
    <div className="container mx-auto py-10 px-4 sm:px-6 max-w-6xl space-y-6 sm:space-y-8">
      
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div className="flex items-center gap-3 sm:gap-4">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-9 sm:w-9 hover:bg-slate-100 dark:hover:bg-slate-800">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2 tracking-tight">
              <UserIcon className="w-6 h-6 sm:w-7 sm:h-7 text-blue-600 dark:text-blue-400" /> Users
            </h1>
        </div>
        <Button onClick={() => setCreateModalOpen(true)} className="h-12 sm:h-10 w-full sm:w-auto font-bold shadow-md sm:shadow-sm">
          <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2" /> Create User
        </Button>
      </div>

      {/* --- DESKTOP VIEW (Hidden on Mobile) --- */}
      <div className="hidden md:block bg-white dark:bg-slate-950 border dark:border-slate-800 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b dark:border-slate-800 text-slate-600 dark:text-slate-300 font-medium">
              <tr>
                <th className="px-6 py-4">User</th>
                <th className="px-6 py-4">Role</th>
                <th className="px-6 py-4 text-center">Login Approved</th>
                <th className="px-6 py-4 text-center">Auto-Approve</th>
                <th className="px-6 py-4 text-center">Downloads</th>
                {/* FIX: Right-aligned header */}
                <th className="px-6 py-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                      {user.username}
                      {user.id === session?.user?.id && <Badge variant="secondary" className="text-[10px] dark:bg-slate-800">You</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{user.email}</div>
                  </td>
                  <td className="px-6 py-4">
                    <Select disabled={updating === user.id} value={user.role} onValueChange={(val) => handleUpdateUser(user.id, 'role', val)}>
                        <SelectTrigger className="w-[110px] h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="USER">User</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent>
                    </Select>
                  </td>
                  <td className="px-6 py-4 text-center"><Switch disabled={updating === user.id || (user.id === session?.user?.id)} checked={user.isApproved} onCheckedChange={(val) => handleUpdateUser(user.id, 'isApproved', val)} /></td>
                  <td className="px-6 py-4 text-center"><Switch disabled={updating === user.id} checked={user.autoApproveRequests} onCheckedChange={(val) => handleUpdateUser(user.id, 'autoApproveRequests', val)} /></td>
                  <td className="px-6 py-4 text-center"><Switch disabled={updating === user.id} checked={user.canDownload} onCheckedChange={(val) => handleUpdateUser(user.id, 'canDownload', val)} /></td>
                  <td className="px-6 py-4">
                    {/* FIX: justify-end applied here */}
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" size="sm" disabled={user.id === session?.user?.id} onClick={() => handleImpersonate(user.id, user.username)} className="h-8 text-xs font-bold shrink-0" title="Login as this user">
                            <Eye className="w-3.5 h-3.5 mr-1.5" /> Login As
                        </Button>
                        
                        {/* FIX: 2FA Reset button wrapped in a fixed-size invisible container */}
                        <div className="w-8 h-8 flex shrink-0">
                            {user.twoFactorEnabled && (
                                <Button variant="outline" size="icon" onClick={() => initiateReset2FA(user.id, user.username)} className="text-orange-500 hover:text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-900/20 h-8 w-8" title="Reset 2FA">
                                    <ShieldOff className="w-4 h-4" />
                                </Button>
                            )}
                        </div>
                        
                        <Button variant="ghost" size="icon" disabled={isDeleting || user.id === session?.user?.id} onClick={() => initiateDelete(user.id, user.username)} className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 h-8 w-8 shrink-0" title="Delete User">
                            <Trash2 className="w-4 h-4" />
                        </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- MOBILE VIEW (Stacked Cards, Hidden on Desktop) --- */}
      <div className="md:hidden space-y-4">
        {users.map((user) => (
          <Card key={user.id} className="shadow-sm border-slate-200 dark:border-slate-800 overflow-hidden">
            <CardContent className="p-0">
              <div className="p-4 border-b dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30 flex justify-between items-start">
                <div>
                  <div className="font-bold text-lg text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    {user.username}
                    {user.id === session?.user?.id && <Badge variant="secondary" className="text-[10px] uppercase tracking-wider dark:bg-slate-800">You</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{user.email}</div>
                </div>
                <Select disabled={updating === user.id || (user.id === session?.user?.id)} value={user.role} onValueChange={(val) => handleUpdateUser(user.id, 'role', val)}>
                    <SelectTrigger className="w-[100px] h-9 text-xs font-bold bg-white dark:bg-slate-950 shadow-sm"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="USER">User</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent>
                </Select>
              </div>
              
              <div className="p-4 space-y-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm">Login Approved</Label>
                  </div>
                  <Switch disabled={updating === user.id || (user.id === session?.user?.id)} checked={user.isApproved} onCheckedChange={(val) => handleUpdateUser(user.id, 'isApproved', val)} className="scale-110" />
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm">Auto-Approve Requests</Label>
                  </div>
                  <Switch disabled={updating === user.id} checked={user.autoApproveRequests} onCheckedChange={(val) => handleUpdateUser(user.id, 'autoApproveRequests', val)} className="scale-110" />
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <DownloadCloud className="w-4 h-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm">Can Download CBZ</Label>
                  </div>
                  <Switch disabled={updating === user.id} checked={user.canDownload} onCheckedChange={(val) => handleUpdateUser(user.id, 'canDownload', val)} className="scale-110" />
                </div>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-900/30 border-t dark:border-slate-800 flex gap-2">
                <Button 
                    variant="outline" 
                    disabled={user.id === session?.user?.id} 
                    onClick={() => handleImpersonate(user.id, user.username)} 
                    className="flex-1 h-12 font-bold shadow-sm bg-white dark:bg-slate-950"
                >
                    <Eye className="w-4 h-4 mr-2" /> Login As
                </Button>
                
                {user.twoFactorEnabled && (
                    <Button 
                        variant="outline" 
                        onClick={() => initiateReset2FA(user.id, user.username)} 
                        className="h-12 w-12 shrink-0 text-orange-500 hover:text-orange-700 hover:bg-orange-50 border-orange-200 dark:border-orange-900/50 dark:hover:bg-orange-900/30 bg-white dark:bg-slate-950"
                        title="Reset 2FA"
                    >
                        <ShieldOff className="w-5 h-5" />
                    </Button>
                )}

                <Button 
                    variant="outline" 
                    disabled={isDeleting || user.id === session?.user?.id} 
                    onClick={() => initiateDelete(user.id, user.username)} 
                    className="h-12 w-12 shrink-0 text-red-500 hover:text-red-700 hover:bg-red-50 border-red-200 dark:border-red-900/50 dark:hover:bg-red-900/30 bg-white dark:bg-slate-950"
                >
                    <Trash2 className="w-5 h-5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* CREATE MODAL */}
      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-md w-[95%] dark:bg-slate-950 dark:border-slate-800 rounded-xl">
            <DialogHeader><DialogTitle className="text-xl">Create New User</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2"><Label>Username</Label><Input className="h-12 sm:h-10 dark:bg-slate-900" value={newUser.username} onChange={e => setNewUser({...newUser, username: e.target.value})} /></div>
                <div className="grid gap-2"><Label>Email</Label><Input type="email" className="h-12 sm:h-10 dark:bg-slate-900" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} /></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="grid gap-2"><Label>Password</Label><Input type="password" className="h-12 sm:h-10 dark:bg-slate-900" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} /></div>
                    <div className="grid gap-2">
                        <Label>Role</Label>
                        <Select value={newUser.role} onValueChange={(val) => setNewUser({...newUser, role: val})}>
                            <SelectTrigger className="h-12 sm:h-10 dark:bg-slate-900"><SelectValue /></SelectTrigger>
                            <SelectContent className="dark:bg-slate-950"><SelectItem value="USER">User</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent>
                        </Select>
                    </div>
                </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" className="h-12 sm:h-10 w-full sm:w-auto" onClick={() => setCreateModalOpen(false)}>Cancel</Button>
                <Button onClick={handleCreateUser} disabled={isCreating} className="h-12 sm:h-10 w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white font-bold">
                    {isCreating ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 mr-2 animate-spin" /> : <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2" />} Create User
                </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog 
        isOpen={deleteConfirmOpen} 
        onClose={() => setDeleteConfirmOpen(false)} 
        onConfirm={handleConfirmedDelete} 
        isLoading={isDeleting} 
        title="Delete User Account" 
        description={`Are you sure you want to permanently delete the account for ${userToDelete?.username}?`} 
        confirmText="Delete Account" 
      />

      {/* 2FA RESET CONFIRMATION */}
      <ConfirmationDialog 
        isOpen={reset2faConfirmOpen} 
        onClose={() => setReset2faConfirmOpen(false)} 
        onConfirm={handleConfirmedReset2FA} 
        isLoading={isResetting2fa} 
        title="Reset Two-Factor Authentication" 
        description={`Are you sure you want to disable 2FA for ${userToReset?.username}? They will only need their password to log in until they set it up again.`} 
        confirmText="Reset 2FA" 
        variant="destructive"
      />
    </div>
  )
}