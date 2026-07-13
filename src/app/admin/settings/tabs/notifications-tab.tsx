// src/app/admin/settings/tabs/notifications-tab.tsx
// Extracted from the settings monolith (Phase 1 reorganization). Pure JSX over the shared
// state bag `s` assembled by page.tsx - all state and handlers live there.
"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import Link from "next/link"
import { Webhook, Smartphone, Send, Globe, Mail, FileEdit, Plus, Loader2, Settings, Trash2, FileText } from "lucide-react"
import { StatusBox, SYSTEM_EVENTS } from "./shared"
import type { SettingsBag } from "./shared"

export function NotificationsTab({ s }: { s: SettingsBag }) {
  const {
    config, setConfig, configuredWebhooks, openWebhookModal, handleTestWebhook,
    testingWebhookId, toggleWebhookActive, deleteWebhook, testResults,
    toggleProviderEvent, handleTest, testing, toast
  } = s;

  return (
    <>
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-foreground">Notification Providers</h2>
              <p className="text-sm text-muted-foreground mt-1">Select and configure the services you want to use to receive automated system alerts.</p>
            </div>

            {/* --- 1. DISCORD --- */}
            <Card className="shadow-sm border-border bg-background">
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2 text-foreground">
                      <Webhook className="w-5 h-5 text-primary" /> Discord
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">
                      Configure automated server alerts using Discord Webhooks.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-4">
                    <Switch 
                        checked={config.discord_enabled !== "false"} 
                        onCheckedChange={(c) => setConfig({...config, discord_enabled: c ? "true" : "false"})} 
                    />
                    {config.discord_enabled !== "false" && (
                        <Button variant="outline" size="sm" onClick={() => openWebhookModal()} className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground transition-colors">
                          <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary" /> Add Webhook
                        </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              
              {config.discord_enabled !== "false" && (
              <CardContent className="space-y-6 border-t border-border pt-6 animate-in fade-in slide-in-from-top-2">
                {configuredWebhooks.length === 0 ? (
                  <div className="border-2 border-dashed border-border rounded-lg p-10 text-center text-muted-foreground">
                    No webhooks configured yet. Add one to start receiving Discord alerts.
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {configuredWebhooks.map(hook => (
                      <div key={hook.id} className="flex flex-col border border-border rounded-lg bg-muted/20 shadow-sm p-4 gap-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="flex flex-col gap-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-lg sm:text-base text-foreground">{hook.name}</span>
                              <Badge variant={hook.isActive ? "secondary" : "outline"} className={hook.isActive ? "bg-primary/10 text-primary border-primary/20" : "text-muted-foreground border-border"}>
                                {hook.isActive ? "Active" : "Disabled"}
                              </Badge>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2 shrink-0 border-t sm:border-0 border-border pt-3 sm:pt-0">
                            <Button 
                              variant="outline" 
                              size="icon" 
                              className="h-10 w-10 sm:h-8 sm:w-8 text-primary hover:bg-primary/10 border-primary/20 transition-colors" 
                              disabled={testingWebhookId === hook.id}
                              onClick={() => handleTestWebhook(hook)}
                            >
                              {testingWebhookId === hook.id ? <Loader2 className="h-5 w-5 sm:h-4 sm:w-4 animate-spin" /> : <Send className="h-5 w-5 sm:h-4 sm:w-4" />}
                            </Button>
                            <Switch checked={hook.isActive} onCheckedChange={() => toggleWebhookActive(hook.id)} className="mx-2 scale-110 sm:scale-100" />
                            <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 hover:bg-muted text-foreground" onClick={() => openWebhookModal(hook)}>
                              <Settings className="h-5 w-5 sm:h-4 sm:w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => deleteWebhook(hook.id)}>
                              <Trash2 className="h-5 w-5 sm:h-4 sm:w-4" />
                            </Button>
                          </div>
                        </div>
                        
                        <div className="flex flex-wrap gap-1.5 bg-background p-2 rounded-md border border-border shadow-inner">
                          {hook.events.map(ev => (
                            <Badge key={ev} variant="outline" className="text-[10px] uppercase tracking-tighter border-border text-muted-foreground">
                              {ev.replace(/_/g, ' ')}
                            </Badge>
                          ))}
                        </div>

                        {testingWebhookId === hook.id && testResults.webhooks && (
                          <StatusBox result={testResults.webhooks} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
              )}
            </Card>

            {/* --- 2. PUSHOVER --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-foreground"><Smartphone className="w-5 h-5 text-primary" /> Pushover</CardTitle>
                            <CardDescription className="text-muted-foreground">Receive instant push notifications on your iOS or Android devices.</CardDescription>
                        </div>
                        <Switch checked={config.pushover_enabled === "true"} onCheckedChange={(c) => setConfig({...config, pushover_enabled: c ? "true" : "false"})} />
                    </div>
                </CardHeader>
                {config.pushover_enabled === "true" && (
                <CardContent className="space-y-4 animate-in fade-in slide-in-from-top-2 border-t border-border pt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="grid gap-2"><Label>Application Token</Label><Input type="password" value={config.pushover_token} onChange={e => setConfig({...config, pushover_token: e.target.value})} placeholder="API Token/Key" className="bg-muted/20 border-border" /></div>
                        <div className="grid gap-2"><Label>User/Group Key</Label><Input value={config.pushover_user} onChange={e => setConfig({...config, pushover_user: e.target.value})} placeholder="User Key" className="bg-muted/20 border-border" /></div>
                    </div>
                    <div className="space-y-3 pt-2">
                        <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                        <div className="grid sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto bg-muted/20 p-4 border border-border rounded-lg">
                            {SYSTEM_EVENTS.map(event => {
                                const isActive = (JSON.parse(config.pushover_events || "[]") as string[]).includes(event.id);
                                return (
                                <div key={event.id} className="flex items-start space-x-3 p-2 rounded hover:bg-background border border-transparent hover:border-border transition-colors group">
                                    <Checkbox id={`po_${event.id}`} checked={isActive} onCheckedChange={() => toggleProviderEvent('pushover', event.id)} className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary" />
                                    <label htmlFor={`po_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">{event.label}</label>
                                </div>
                            )})}
                        </div>
                    </div>
                    <Button variant="outline" className="w-full sm:w-auto mt-2 border-border font-bold hover:bg-muted" onClick={() => handleTest('pushover', config)} disabled={!!testing}>
                        {testing === 'pushover' ? <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" /> : <Send className="w-4 h-4 mr-2 text-primary" />} Test Pushover
                    </Button>
                    <StatusBox result={testResults.pushover} />
                </CardContent>
                )}
            </Card>

            {/* --- 3. TELEGRAM --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-foreground"><Send className="w-5 h-5 text-primary" /> Telegram</CardTitle>
                            <CardDescription className="text-muted-foreground">Send Omnibus alerts directly to a Telegram chat or channel.</CardDescription>
                        </div>
                        <Switch checked={config.telegram_enabled === "true"} onCheckedChange={(c) => setConfig({...config, telegram_enabled: c ? "true" : "false"})} />
                    </div>
                </CardHeader>
                {config.telegram_enabled === "true" && (
                <CardContent className="space-y-4 animate-in fade-in slide-in-from-top-2 border-t border-border pt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="grid gap-2"><Label>Bot Token</Label><Input type="password" value={config.telegram_bot_token} onChange={e => setConfig({...config, telegram_bot_token: e.target.value})} placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" className="bg-muted/20 border-border" /></div>
                        <div className="grid gap-2"><Label>Chat ID</Label><Input value={config.telegram_chat_id} onChange={e => setConfig({...config, telegram_chat_id: e.target.value})} placeholder="-1001234567890" className="bg-muted/20 border-border" /></div>
                    </div>
                    <div className="space-y-3 pt-2">
                        <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                        <div className="grid sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto bg-muted/20 p-4 border border-border rounded-lg">
                            {SYSTEM_EVENTS.map(event => {
                                const isActive = (JSON.parse(config.telegram_events || "[]") as string[]).includes(event.id);
                                return (
                                <div key={event.id} className="flex items-start space-x-3 p-2 rounded hover:bg-background border border-transparent hover:border-border transition-colors group">
                                    <Checkbox id={`tg_${event.id}`} checked={isActive} onCheckedChange={() => toggleProviderEvent('telegram', event.id)} className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary" />
                                    <label htmlFor={`tg_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">{event.label}</label>
                                </div>
                            )})}
                        </div>
                    </div>
                    <Button variant="outline" className="w-full sm:w-auto mt-2 border-border font-bold hover:bg-muted" onClick={() => handleTest('telegram', config)} disabled={!!testing}>
                        {testing === 'telegram' ? <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" /> : <Send className="w-4 h-4 mr-2 text-primary" />} Test Telegram
                    </Button>
                    <StatusBox result={testResults.telegram} />
                </CardContent>
                )}
            </Card>

            {/* --- 4. APPRISE --- */}
            <Card className="shadow-sm border-border bg-background">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-foreground"><Globe className="w-5 h-5 text-primary" /> Apprise</CardTitle>
                            <CardDescription className="text-muted-foreground">Route notifications through an Apprise instance to support 80+ other services.</CardDescription>
                        </div>
                        <Switch checked={config.apprise_enabled === "true"} onCheckedChange={(c) => setConfig({...config, apprise_enabled: c ? "true" : "false"})} />
                    </div>
                </CardHeader>
                {config.apprise_enabled === "true" && (
                <CardContent className="space-y-4 animate-in fade-in slide-in-from-top-2 border-t border-border pt-6">
                    {/* ADDED: type="password" to the Apprise Input */}
                    <div className="grid gap-2"><Label>Apprise URL</Label><Input type="password" value={config.apprise_url} onChange={e => setConfig({...config, apprise_url: e.target.value})} placeholder="http://apprise:8000/notify/apprise" className="bg-muted/20 border-border" /></div>
                    <div className="space-y-3 pt-2">
                        <Label className="text-xs font-bold uppercase text-muted-foreground">Trigger Events</Label>
                        <div className="grid sm:grid-cols-2 gap-2 max-h-[250px] overflow-y-auto bg-muted/20 p-4 border border-border rounded-lg">
                            {SYSTEM_EVENTS.map(event => {
                                const isActive = (JSON.parse(config.apprise_events || "[]") as string[]).includes(event.id);
                                return (
                                <div key={event.id} className="flex items-start space-x-3 p-2 rounded hover:bg-background border border-transparent hover:border-border transition-colors group">
                                    <Checkbox id={`ap_${event.id}`} checked={isActive} onCheckedChange={() => toggleProviderEvent('apprise', event.id)} className="mt-1 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary" />
                                    <label htmlFor={`ap_${event.id}`} className="text-sm font-bold leading-none cursor-pointer text-foreground group-hover:text-primary transition-colors">{event.label}</label>
                                </div>
                            )})}
                        </div>
                    </div>
                    <Button variant="outline" className="w-full sm:w-auto mt-2 border-border font-bold hover:bg-muted" onClick={() => handleTest('apprise', config)} disabled={!!testing}>
                        {testing === 'apprise' ? <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" /> : <Globe className="w-4 h-4 mr-2 text-primary" />} Test Apprise
                    </Button>
                    <StatusBox result={testResults.apprise} />
                </CardContent>
                )}
            </Card>

            {/* --- 5. EMAIL --- */}
            <Card className="shadow-sm border-border bg-background mt-6">
                <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-foreground">
                            <Mail className="w-5 h-5 text-primary" /> SMTP Email Alerts
                        </CardTitle>
                        <CardDescription className="text-muted-foreground mt-1">Configure an SMTP server to send email notifications for approvals and fulfilled requests.</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" asChild className="h-12 sm:h-9 font-bold border-border hover:bg-muted text-foreground transition-colors w-full sm:w-auto">
                        <Link href="/admin/email-templates"><FileEdit className="w-4 h-4 mr-2 text-primary" /> Customize Templates</Link>
                    </Button>
                </div>
                </CardHeader>
                <CardContent className="space-y-6 border-t border-border pt-6">
                <div className="flex items-center space-x-2">
                    <Switch checked={config.smtp_enabled === "true"} onCheckedChange={(c) => setConfig({...config, smtp_enabled: c ? "true" : "false"})} />
                    <Label className="cursor-pointer font-bold">Enable Email Notifications</Label>
                </div>
                {config.smtp_enabled === "true" && (
                    <div className="grid gap-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="grid gap-2"><Label>SMTP Host</Label><Input value={config.smtp_host} onChange={e => setConfig({...config, smtp_host: e.target.value})} placeholder="smtp.gmail.com" className="bg-muted/20 border-border text-foreground" /></div>
                            <div className="grid gap-2"><Label>SMTP Port</Label><Input value={config.smtp_port} onChange={e => setConfig({...config, smtp_port: e.target.value})} placeholder="587" className="bg-muted/20 border-border text-foreground" /></div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="grid gap-2"><Label>SMTP Username</Label><Input value={config.smtp_user} onChange={e => setConfig({...config, smtp_user: e.target.value})} placeholder="user@gmail.com" className="bg-muted/20 border-border text-foreground" /></div>
                            <div className="grid gap-2"><Label>SMTP Password</Label><Input type="password" value={config.smtp_pass} onChange={e => setConfig({...config, smtp_pass: e.target.value})} placeholder="App Password" className="bg-muted/20 border-border text-foreground" /></div>
                        </div>
                        <div className="grid gap-2"><Label>From Email Address</Label><Input value={config.smtp_from} onChange={e => setConfig({...config, smtp_from: e.target.value})} placeholder="omnibus@yourdomain.com" className="bg-muted/20 border-border text-foreground" /></div>
                        
                        <div className="border-t border-border pt-4 flex flex-col sm:flex-row gap-2">
                            <Input id="smtp-test-email" placeholder="Send test email to..." className="bg-muted/20 border-border max-w-xs text-foreground flex-1 sm:flex-none" />
                            <div className="flex gap-2">
                                <Button variant="outline" className="border-border hover:bg-muted text-foreground flex-1 sm:flex-none" onClick={() => {
                                    const testEmail = (document.getElementById('smtp-test-email') as HTMLInputElement)?.value;
                                    if (testEmail) handleTest('smtp', { ...config, test_email: testEmail });
                                    else toast({ title: "Validation Error", description: "Enter an email to test.", variant: "destructive" });
                                }} disabled={!!testing}>
                                    {testing === 'smtp' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />} Test SMTP
                                </Button>
                                <Button variant="outline" className="border-primary/30 text-primary bg-primary/10 hover:bg-primary/20 flex-1 sm:flex-none" onClick={() => {
                                    const testEmail = (document.getElementById('smtp-test-email') as HTMLInputElement)?.value;
                                    if (testEmail) handleTest('smtp_digest', { ...config, test_email: testEmail });
                                    else toast({ title: "Validation Error", description: "Enter an email to test.", variant: "destructive" });
                                }} disabled={!!testing}>
                                    {testing === 'smtp_digest' ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <FileText className="w-4 h-4 mr-2" />} Test Weekly Digest
                                </Button>
                            </div>
                        </div>
                        <StatusBox result={testResults.smtp || testResults.smtp_digest} />
                    </div>
                )}
                </CardContent>
            </Card>

          </div>
    </>
  )
}
