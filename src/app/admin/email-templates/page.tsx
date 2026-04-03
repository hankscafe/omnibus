// src/app/admin/email-templates/page.tsx
"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, Save, Loader2, FileEdit, Code, Info } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import Link from "next/link"

const TEMPLATE_KEYS = [
    { id: "account_approved", label: "Account Approved", vars: ["user"] },
    { id: "comic_available", label: "Comic Available", vars: ["title"] },
    { id: "request_approved", label: "Request Approved", vars: ["user", "title"] },
    { id: "pending_request", label: "Pending Request", vars: ["user", "title"] },
    { id: "pending_account", label: "Pending Account", vars: ["user", "email"] },
    { id: "weekly_digest", label: "Weekly Digest", vars: ["comics_html", "manga_html"] },
];

const DEFAULT_TEMPLATES: Record<string, string> = {
    account_approved: `<h2 style="color: #f8fafc; margin-top: 0;">Welcome aboard!</h2>\n<p>Hello <strong>{{user}}</strong>,</p>\n<p>Your account has been approved by an administrator. You can now log in to your Omnibus library and begin reading.</p>`,
    comic_available: `<h2 style="color: #f8fafc; margin-top: 0;">Ready to Read</h2>\n<p>Good news!</p>\n<p>Your request for <strong>{{title}}</strong> has finished downloading and is now available in the library.</p>`,
    request_approved: `<h2 style="color: #f8fafc; margin-top: 0;">Request Accepted</h2>\n<p>Your request for <strong>{{title}}</strong> has been approved by {{user}}.</p>\n<p>It has been sent to the download client and will be available in your library shortly.</p>`,
    pending_request: `<h2 style="color: #f8fafc; margin-top: 0;">Approval Required</h2>\n<p>User <strong>{{user}}</strong> has requested <strong>{{title}}</strong>.</p>\n<p>Please review and approve the request in the Omnibus admin dashboard.</p>`,
    pending_account: `<h2 style="color: #f8fafc; margin-top: 0;">Account Approval Required</h2>\n<p>A new user <strong>{{user}}</strong> ({{email}}) has registered and is waiting for approval to access the server.</p>`,
    weekly_digest: `<h2 style="color: #f8fafc; margin-top: 0; font-size: 24px; font-weight: 800;">This Week's Additions</h2>\n<p style="color: #cbd5e1; font-size: 15px; margin-bottom: 24px;">Here are the latest issues that have been downloaded and added to your library over the past 7 days.</p>\n{{comics_html}}\n{{manga_html}}`
};

export default function EmailTemplatesPage() {
  const [activeTemplate, setActiveTemplate] = useState(TEMPLATE_KEYS[0].id);
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    document.title = "Omnibus - Email Templates";
    fetch('/api/admin/config')
        .then(res => res.json())
        .then(data => {
            const loadedTemplates: Record<string, string> = {};
            if (data.settings && Array.isArray(data.settings)) {
                TEMPLATE_KEYS.forEach(tk => {
                    const dbSetting = data.settings.find((s: any) => s.key === `email_template_${tk.id}`);
                    loadedTemplates[tk.id] = dbSetting ? dbSetting.value : DEFAULT_TEMPLATES[tk.id];
                });
            }
            setTemplates(loadedTemplates);
        })
        .catch(() => toast({ title: "Error loading templates", variant: "destructive" }))
        .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  const handleSave = async () => {
    setSaving(true);
    
    // We only need to save the template keys to the config endpoint
    const payloadSettings: Record<string, string> = {};
    TEMPLATE_KEYS.forEach(tk => {
        payloadSettings[`email_template_${tk.id}`] = templates[tk.id];
    });

    try {
        const res = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: payloadSettings })
        });

        if (res.ok) {
            toast({ title: "Templates Saved", description: "Your custom email templates have been saved." });
        } else {
            toast({ title: "Failed to save", variant: "destructive" });
        }
    } catch (e) {
        toast({ title: "Error saving templates", variant: "destructive" });
    } finally {
        setSaving(false);
    }
  };

  const handleReset = () => {
      setTemplates(prev => ({
          ...prev,
          [activeTemplate]: DEFAULT_TEMPLATES[activeTemplate]
      }));
      toast({ title: "Template Reset", description: "Reverted to the default template." });
  };

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  const currentTemplateObj = TEMPLATE_KEYS.find(tk => tk.id === activeTemplate);

  return (
    <div className="container mx-auto py-10 px-6 max-w-5xl space-y-8 transition-colors duration-300">
      
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" asChild className="hover:bg-muted text-foreground">
              <Link href="/admin/settings"><ArrowLeft className="w-5 h-5" /></Link>
            </Button>
            <div>
              <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
                <FileEdit className="w-8 h-8 text-primary" /> Email Templates
              </h1>
              <p className="text-muted-foreground mt-1">Customize the inner HTML of the automated emails sent by Omnibus.</p>
            </div>
        </div>
        <Button onClick={handleSave} disabled={saving} size="lg" className="w-full sm:w-auto h-12 sm:h-10 font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-md">
            {saving ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Save className="w-5 h-5 mr-2" />} Save Templates
        </Button>
      </div>

      <Card className="shadow-sm border-border bg-background overflow-hidden">
          <CardHeader className="bg-muted/50 border-b border-border pb-4">
              <CardTitle className="flex items-center gap-2 text-foreground"><Info className="w-5 h-5 text-primary" /> Template Engine Notes</CardTitle>
              <CardDescription className="text-foreground/80">
                  You are editing the <strong>inner content block</strong> of the email. Omnibus automatically wraps this content in a beautiful, dark-themed responsive container with the Omnibus header and footer. Use basic inline HTML styling for the best results.
              </CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-8">
              
              {/* Dropdown Selector */}
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 border-b border-border pb-6">
                  <div className="w-full sm:w-[350px]">
                      <Label className="mb-2 block text-xs font-bold text-muted-foreground uppercase tracking-widest">Select Template to Edit</Label>
                      <Select value={activeTemplate} onValueChange={setActiveTemplate}>
                          <SelectTrigger className="w-full h-12 font-bold bg-background border-border">
                              <SelectValue placeholder="Select a template..." />
                          </SelectTrigger>
                          <SelectContent className="bg-popover border-border">
                              {TEMPLATE_KEYS.map(tk => (
                                  <SelectItem key={tk.id} value={tk.id} className="focus:bg-primary/10 focus:text-primary">
                                      {tk.label}
                                  </SelectItem>
                              ))}
                          </SelectContent>
                      </Select>
                  </div>
                  <Button variant="outline" onClick={handleReset} className="w-full sm:w-auto border-border hover:bg-muted text-foreground h-12 font-bold">
                      Reset to Default
                  </Button>
              </div>

              {/* Editor Section */}
              {currentTemplateObj && (
                  <div className="space-y-4 animate-in fade-in zoom-in-95 duration-300">
                      <div>
                          <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                              <Code className="w-5 h-5 text-muted-foreground" /> {currentTemplateObj.label} HTML
                          </h3>
                          <div className="flex flex-wrap gap-2 mt-2 items-center">
                              <span className="text-xs font-bold text-muted-foreground">Available Variables:</span>
                              {currentTemplateObj.vars.map(v => (
                                  <code key={v} className="text-[11px] bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded font-mono font-bold">
                                      {`{{${v}}}`}
                                  </code>
                              ))}
                          </div>
                      </div>
                      
                      <Textarea 
                          value={templates[activeTemplate] || ""}
                          onChange={e => setTemplates({ ...templates, [activeTemplate]: e.target.value })}
                          className="min-h-[400px] font-mono text-sm leading-relaxed bg-slate-950 text-slate-300 border-border p-5 shadow-inner resize-y focus-visible:ring-primary"
                          spellCheck={false}
                      />
                  </div>
              )}
              
          </CardContent>
      </Card>
    </div>
  )
}