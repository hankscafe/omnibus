// src/app/admin/users/page.tsx
"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Loader2, User as UserIcon, Trash2, Plus, Eye, Shield, DownloadCloud, Activity, ShieldOff, Mail } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { getErrorMessage } from "@/lib/utils/error"

export default function AdminUsersPage() {
  useEffect(() => {
      document.title = "Omnibus - Users";
  }, []);

  const [copied, setCopied] = useState(false);
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

  // Password Reset States
  const [resetPassConfirmOpen, setResetPassConfirmOpen] = useState(false)
  const [userToResetPass, setUserToResetPass] = useState<{ id: string, username: string } | null>(null)
  const [isResettingPass, setIsResettingPass] = useState(false)

  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [newUser, setNewUser] = useState({
      username: '', email: '', password: '', role: 'USER',
      isApproved: true, autoApproveRequests: false, canDownload: false
  })
  
  const { toast } = useToast()

  const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ title: "Copied!", description: "API Key copied to clipboard." });
      
      // --- FIX: Reset state after 2 seconds ---
      setTimeout(() => setCopied(false), 2000);
  }

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
        const data = await res.json()
        toast({ title: "User Updated", description: "Changes saved successfully." })
        setUsers(prev => prev.map(u => u.id === id ? data.user : u))
      } else throw new Error("Update failed")
    } catch (error: unknown) {
      toast({ title: "Update Failed", description: getErrorMessage(error), variant: "destructive" })
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
      } catch (error: unknown) {
          toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
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
    } catch (error: unknown) {
        toast({ title: "Delete Failed", description: getErrorMessage(error), variant: "destructive" });
    } finally {
        setIsDeleting(false);
        setUserToDelete(null);
    }
  }

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
    } catch (error: unknown) {
        toast({ title: "Reset Failed", description: getErrorMessage(error), variant: "destructive" });
    } finally {
        setIsResetting2fa(false);
        setUserToReset(null);
    }
  }

  // --- NEW: Password Reset Handlers ---
  const initiateResetPassword = (id: string, username: string) => {
      setUserToResetPass({ id, username });
      setResetPassConfirmOpen(true);
  }

  const handleConfirmedResetPassword = async () => {
      if (!userToResetPass) return;
      setIsResettingPass(true);
      try {
          const res = await fetch('/api/admin/users/reset-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: userToResetPass.id })
          });
          const data = await res.json();
          if (res.ok) {
              toast({ title: "Reset Email Sent", description: `A password reset link has been sent to ${userToResetPass.username}.` });
              setResetPassConfirmOpen(false);
          } else throw new Error(data.error || "Failed to send reset email");
      } catch (error: any) {
          toast({ title: "Reset Failed", description: error.message, variant: "destructive" });
      } finally {
          setIsResettingPass(false);
          setUserToResetPass(null);
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
      } catch (error: unknown) {
          toast({ title: "Creation Failed", description: getErrorMessage(error), variant: "destructive" });
      } finally { setIsCreating(false); }
  }

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>

  return (
    <div className="container mx-auto py-10 px-4 sm:px-6 max-w-6xl space-y-6 sm:space-y-8 transition-colors duration-300">
      
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div className="flex items-center gap-3 sm:gap-4">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-9 sm:w-9 hover:bg-muted text-foreground">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2 tracking-tight text-foreground">
              <UserIcon className="w-6 h-6 sm:w-7 sm:h-7 text-primary" /> Users
            </h1>
        </div>
        <Button onClick={() => setCreateModalOpen(true)} className="h-12 sm:h-10 w-full sm:w-auto font-bold shadow-md sm:shadow-sm bg-primary hover:bg-primary/90 text-primary-foreground">
          <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2" /> Create User
        </Button>
      </div>

      {/* --- DESKTOP VIEW --- */}
      <div className="hidden md:block bg-background border border-border rounded-xl shadow-sm overflow-hidden transition-colors duration-300">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 border-b border-border text-muted-foreground font-medium uppercase text-xs">
              <tr>
                <th className="px-6 py-4">User</th>
                <th className="px-6 py-4">Role</th>
                <th className="px-6 py-4 text-center">Login Approved</th>
                <th className="px-6 py-4 text-center">Auto-Approve</th>
                <th className="px-6 py-4 text-center">Downloads</th>
                <th className="px-6 py-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-bold text-foreground flex items-center gap-2">
                      {user.username}
                      {user.id === session?.user?.id && <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary border-primary/20">You</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{user.email}</div>
                  </td>
                  <td className="px-6 py-4">
                    <Select disabled={updating === user.id} value={user.role} onValueChange={(val) => handleUpdateUser(user.id, 'role', val)}>
                        <SelectTrigger className="w-[110px] h-8 text-xs bg-background border-border"><SelectValue /></SelectTrigger>
                        <SelectContent className="bg-popover border-border">
                            <SelectItem value="USER" className="focus:bg-primary/10 focus:text-primary">User</SelectItem>
                            <SelectItem value="ADMIN" className="focus:bg-primary/10 focus:text-primary">Admin</SelectItem>
                        </SelectContent>
                    </Select>
                  </td>
                  <td className="px-6 py-4 text-center"><Switch disabled={updating === user.id || (user.id === session?.user?.id)} checked={user.isApproved} onCheckedChange={(val) => handleUpdateUser(user.id, 'isApproved', val)} /></td>
                  <td className="px-6 py-4 text-center"><Switch disabled={updating === user.id} checked={user.autoApproveRequests} onCheckedChange={(val) => handleUpdateUser(user.id, 'autoApproveRequests', val)} /></td>
                  <td className="px-6 py-4 text-center"><Switch disabled={updating === user.id} checked={user.canDownload} onCheckedChange={(val) => handleUpdateUser(user.id, 'canDownload', val)} /></td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                        <Button variant="outline" size="sm" disabled={user.id === session?.user?.id} onClick={() => handleImpersonate(user.id, user.username)} className="h-8 text-xs font-bold shrink-0 border-border hover:bg-muted text-foreground" title="Login as this user">
                            <Eye className="w-3.5 h-3.5 mr-1.5" /> Login As
                        </Button>
                        
                        <Button variant="outline" size="icon" onClick={() => initiateResetPassword(user.id, user.username)} className="text-blue-500 hover:text-blue-600 border-border hover:bg-muted h-8 w-8 shrink-0" title="Send Password Reset Email">
                            <Mail className="w-4 h-4" />
                        </Button>

                        <div className="w-8 h-8 flex shrink-0">
                            {user.twoFactorEnabled && (
                                <Button variant="outline" size="icon" onClick={() => initiateReset2FA(user.id, user.username)} className="text-orange-500 hover:text-orange-600 border-border hover:bg-muted h-8 w-8" title="Reset 2FA">
                                    <ShieldOff className="w-4 h-4" />
                                </Button>
                            )}
                        </div>
                        
                        <Button variant="ghost" size="icon" disabled={isDeleting || user.id === session?.user?.id} onClick={() => initiateDelete(user.id, user.username)} className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 h-8 w-8 shrink-0" title="Delete User">
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

      {/* --- MOBILE VIEW --- */}
      <div className="md:hidden space-y-4">
        {users.map((user) => (
          <Card key={user.id} className="shadow-sm border-border overflow-hidden bg-background">
            <CardContent className="p-0">
              <div className="p-4 border-b border-border bg-muted/50 flex justify-between items-start">
                <div>
                  <div className="font-bold text-lg text-foreground flex items-center gap-2">
                    {user.username}
                    {user.id === session?.user?.id && <Badge variant="secondary" className="text-[10px] uppercase tracking-wider bg-primary/10 text-primary border-primary/20">You</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{user.email}</div>
                </div>
                <Select disabled={updating === user.id || (user.id === session?.user?.id)} value={user.role} onValueChange={(val) => handleUpdateUser(user.id, 'role', val)}>
                    <SelectTrigger className="w-[100px] h-9 text-xs font-bold bg-background border-border shadow-sm"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                        <SelectItem value="USER" className="focus:bg-primary/10 focus:text-primary">User</SelectItem>
                        <SelectItem value="ADMIN" className="focus:bg-primary/10 focus:text-primary">Admin</SelectItem>
                    </SelectContent>
                </Select>
              </div>
              
              <div className="p-4 space-y-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm text-foreground">Login Approved</Label>
                  </div>
                  <Switch disabled={updating === user.id || (user.id === session?.user?.id)} checked={user.isApproved} onCheckedChange={(val) => handleUpdateUser(user.id, 'isApproved', val)} className="scale-110" />
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm text-foreground">Auto-Approve Requests</Label>
                  </div>
                  <Switch disabled={updating === user.id} checked={user.autoApproveRequests} onCheckedChange={(val) => handleUpdateUser(user.id, 'autoApproveRequests', val)} className="scale-110" />
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <DownloadCloud className="w-4 h-4 text-muted-foreground" />
                    <Label className="font-semibold text-sm text-foreground">Can Download CBZ</Label>
                  </div>
                  <Switch disabled={updating === user.id} checked={user.canDownload} onCheckedChange={(val) => handleUpdateUser(user.id, 'canDownload', val)} className="scale-110" />
                </div>
              </div>

              <div className="p-3 bg-muted/50 border-t border-border flex gap-2">
                <Button 
                    variant="outline" 
                    disabled={user.id === session?.user?.id} 
                    onClick={() => handleImpersonate(user.id, user.username)} 
                    className="flex-1 h-12 font-bold shadow-sm bg-background border-border hover:bg-muted text-foreground"
                >
                    <Eye className="w-4 h-4 mr-2" /> Login As
                </Button>
                
                <Button 
                    variant="outline" 
                    onClick={() => initiateResetPassword(user.id, user.username)} 
                    className="h-12 w-12 shrink-0 text-blue-500 hover:text-blue-600 border-border hover:bg-muted bg-background"
                    title="Send Password Reset"
                >
                    <Mail className="w-5 h-5" />
                </Button>

                {user.twoFactorEnabled && (
                    <Button 
                        variant="outline" 
                        onClick={() => initiateReset2FA(user.id, user.username)} 
                        className="h-12 w-12 shrink-0 text-orange-500 hover:text-orange-600 border-border hover:bg-muted bg-background"
                        title="Reset 2FA"
                    >
                        <ShieldOff className="w-5 h-5" />
                    </Button>
                )}

                <Button 
                    variant="outline" 
                    disabled={isDeleting || user.id === session?.user?.id} 
                    onClick={() => initiateDelete(user.id, user.username)} 
                    className="h-12 w-12 shrink-0 text-red-500 hover:text-red-600 border-border hover:bg-muted bg-background"
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
        <DialogContent className="sm:max-w-md w-[95%] bg-background border-border rounded-xl shadow-2xl transition-colors duration-300">
            <DialogHeader><DialogTitle className="text-xl text-foreground">Create New User</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2"><Label className="text-foreground">Username</Label><Input className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" value={newUser.username} onChange={e => setNewUser({...newUser, username: e.target.value})} /></div>
                <div className="grid gap-2"><Label className="text-foreground">Email</Label><Input type="email" className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} /></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="grid gap-2"><Label className="text-foreground">Password</Label><Input type="password" className="h-12 sm:h-10 bg-muted/50 border-border text-foreground" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} /></div>
                    <div className="grid gap-2">
                        <Label className="text-foreground">Role</Label>
                        <Select value={newUser.role} onValueChange={(val) => setNewUser({...newUser, role: val})}>
                            <SelectTrigger className="h-12 sm:h-10 bg-muted/50 border-border text-foreground"><SelectValue /></SelectTrigger>
                            <SelectContent className="bg-popover border-border">
                                <SelectItem value="USER" className="focus:bg-primary/10 focus:text-primary">User</SelectItem>
                                <SelectItem value="ADMIN" className="focus:bg-primary/10 focus:text-primary">Admin</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" className="h-12 sm:h-10 w-full sm:w-auto border-border hover:bg-muted text-foreground" onClick={() => setCreateModalOpen(false)}>Cancel</Button>
                <Button onClick={handleCreateUser} disabled={isCreating} className="h-12 sm:h-10 w-full sm:w-auto bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
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

      <ConfirmationDialog 
        isOpen={resetPassConfirmOpen} 
        onClose={() => setResetPassConfirmOpen(false)} 
        onConfirm={handleConfirmedResetPassword} 
        isLoading={isResettingPass} 
        title="Send Password Reset" 
        description={`Are you sure you want to send a password reset email to ${userToResetPass?.username}? They will receive a secure link valid for 1 hour.`} 
        confirmText="Send Email" 
        variant="default"
      />
    </div>
  )
}