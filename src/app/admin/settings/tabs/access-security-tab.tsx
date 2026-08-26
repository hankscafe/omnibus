// src/app/admin/settings/tabs/access-security-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import Link from "next/link"
import { Fingerprint, Webhook, Plus, Loader2, XCircle, CheckCircle2, X, AlertCircle, Copy, AlertTriangle, Trash2, Shield } from "lucide-react"

import type { SettingsBag } from "./shared"

export function AccessSecurityTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, users, apiKeys, newKeyName, setNewKeyName, newKeyUserId, setNewKeyUserId,
    newKeyExpiration, setNewKeyExpiration, handleGenerateKey, isGeneratingKey,
    generatedKey, setGeneratedKey, generateError, setGenerateError,
    handleRevokeKey, copyToClipboard, customHeaders, addHeader, updateHeader, removeHeader
  } = s;

  return (
    <>
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Shield className="w-5 h-5 text-primary" /> Account Registration</CardTitle>
                    <CardDescription className="text-muted-foreground">Control whether new users can sign themselves up from the login page.</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Switch
                            id="allow-registration-toggle"
                            checked={config.allow_registration !== "false"}
                            onCheckedChange={(c) => setConfig({...config, allow_registration: c ? "true" : "false"})}
                            className="scale-110 sm:scale-100"
                        />
                        <div className="grid gap-1">
                            <Label htmlFor="allow-registration-toggle" className="cursor-pointer font-bold text-base text-foreground">Allow user self-registration</Label>
                            <p className="text-xs text-muted-foreground">When off, the login page hides Register and the API refuses new sign-ups. Admins can still create accounts from the Users list, and a fresh install&apos;s first-run setup is never blocked.</p>
                        </div>
                    </div>
                </CardContent>
            </Card>

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
                                
                                {/* --- BLANKET AUTO-APPROVE WARNING --- */}
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
            <Card className="shadow-sm border-border bg-background mb-6">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Webhook className="w-5 h-5 text-primary" /> External API Integrations</CardTitle>
                    <CardDescription className="text-muted-foreground">Generate API keys to allow external applications (like Discord Bots or Homepage Dashboards) to fetch stats and interact with Omnibus securely. <span className="font-semibold text-foreground/80">Keys are created and revoked immediately — unlike the rest of this page, they don&apos;t wait for Save All Changes.</span></CardDescription>
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
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-foreground"><Shield className="w-5 h-5 text-primary" /> Outbound Requests</CardTitle>
                    <CardDescription className="text-muted-foreground">Extra HTTP headers Omnibus attaches to its outgoing requests (e.g. Cloudflare Access service tokens).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
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
    </>
  )
}
