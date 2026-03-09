"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2, XCircle, ArrowLeft, Download } from "lucide-react"
import Link from "next/link"
import { useToast } from "@/components/ui/use-toast"

export default function DownloaderSettings() {
  // qBittorrent State
  const [qbitUrl, setQbitUrl] = useState("")
  const [qbitUser, setQbitUser] = useState("")
  const [qbitPass, setQbitPass] = useState("")
  
  // SABnzbd State
  const [sabUrl, setSabUrl] = useState("")
  const [sabKey, setSabKey] = useState("")

  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const { toast } = useToast()

  useEffect(() => {
    document.title = "Omnibus - Download Settings";
    fetch('/api/settings/downloaders')
      .then(res => res.json())
      .then(data => {
        if (data.qbit_url) setQbitUrl(data.qbit_url)
        if (data.qbit_username) setQbitUser(data.qbit_username)
        if (data.sab_url) setSabUrl(data.sab_url)
        if (data.sab_apikey) setSabKey(data.sab_apikey)
      })
  }, [])

  const handleTest = async (type: 'qbit' | 'sab') => {
    setLoading(true); 
    setStatus('idle');
    const body = type === 'qbit' 
      ? { type, testOnly: true, url: qbitUrl, username: qbitUser, password: qbitPass }
      : { type, testOnly: true, url: sabUrl, apiKey: sabKey };

    try {
      const res = await fetch('/api/settings/downloaders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      setStatus(data.success ? 'success' : 'error');
      
      toast({
        title: data.success ? "Connection Successful" : "Connection Failed",
        description: data.message || (data.success ? "Omnibus can communicate with the client." : "Verify your URL and credentials."),
        variant: data.success ? "default" : "destructive"
      });
    } catch {
      setStatus('error');
      toast({ title: "Error", description: "Could not reach the server API.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  const handleSave = async (type: 'qbit' | 'sab') => {
    setLoading(true);
    const body = type === 'qbit' 
      ? { type, testOnly: false, url: qbitUrl, username: qbitUser, password: qbitPass }
      : { type, testOnly: false, url: sabUrl, apiKey: sabKey };

    try {
      const res = await fetch('/api/settings/downloaders', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) 
      });
      if (res.ok) {
        toast({ title: "Settings Saved", description: "Your download client configuration has been updated." });
      } else {
        throw new Error();
      }
    } catch {
      toast({ title: "Save Failed", description: "Could not update settings.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container max-w-2xl mx-auto py-10 px-6 space-y-8 transition-colors duration-300">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild className="hover:bg-muted text-foreground">
          <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
          <Download className="w-8 h-8 text-primary" />
          Download Clients
        </h1>
      </div>
      
      <Tabs defaultValue="qbit" className="w-full">
        <TabsList className="grid w-full grid-cols-2 bg-muted border border-border p-1">
          <TabsTrigger value="qbit" className="data-[state=active]:bg-background data-[state=active]:text-primary font-bold">qBittorrent</TabsTrigger>
          <TabsTrigger value="sab" className="data-[state=active]:bg-background data-[state=active]:text-primary font-bold">SABnzbd</TabsTrigger>
        </TabsList>

        {/* qBittorrent Tab */}
        <TabsContent value="qbit" className="mt-6 animate-in fade-in slide-in-from-bottom-2">
          <Card className="border-border bg-background shadow-sm">
            <CardHeader>
              <CardTitle className="text-foreground">qBittorrent Settings</CardTitle>
              <CardDescription className="text-muted-foreground">Configure your torrent client for automated downloads.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label className="text-foreground font-semibold">Server URL</Label>
                <Input 
                  value={qbitUrl} 
                  onChange={e => { setQbitUrl(e.target.value); setStatus('idle'); }} 
                  placeholder="http://192.168.1.100:8080" 
                  className="bg-muted/50 border-border focus-visible:ring-primary"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-foreground font-semibold">Username</Label>
                <Input 
                  value={qbitUser} 
                  onChange={e => { setQbitUser(e.target.value); setStatus('idle'); }} 
                  placeholder="admin" 
                  className="bg-muted/50 border-border focus-visible:ring-primary"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-foreground font-semibold">Password</Label>
                <Input 
                  type="password" 
                  value={qbitPass} 
                  onChange={e => { setQbitPass(e.target.value); setStatus('idle'); }} 
                  placeholder="Enter password..." 
                  className="bg-muted/50 border-border focus-visible:ring-primary"
                />
              </div>

              <div className="flex flex-col sm:flex-row justify-between gap-3 pt-6">
                <Button variant="outline" onClick={() => handleTest('qbit')} disabled={loading} className="border-border hover:bg-muted font-bold order-2 sm:order-1">
                  {loading ? <Loader2 className="animate-spin w-4 h-4 mr-2" /> : null}
                  Test Connection
                </Button>
                <Button onClick={() => handleSave('qbit')} disabled={loading} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold order-1 sm:order-2">
                  Save Settings
                </Button>
              </div>

              <div className="pt-2">
                {status === 'success' && (
                  <div className="text-green-600 dark:text-green-400 text-sm font-bold flex items-center bg-green-500/10 p-3 rounded-lg border border-green-500/20 animate-in zoom-in-95">
                    <CheckCircle2 className="w-4 h-4 mr-2"/> Connection Successful
                  </div>
                )}
                {status === 'error' && (
                  <div className="text-red-600 dark:text-red-400 text-sm font-bold flex items-center bg-red-500/10 p-3 rounded-lg border border-red-500/20 animate-in zoom-in-95">
                    <XCircle className="w-4 h-4 mr-2"/> Connection Failed
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* SABnzbd Tab */}
        <TabsContent value="sab" className="mt-6 animate-in fade-in slide-in-from-bottom-2">
          <Card className="border-border bg-background shadow-sm">
            <CardHeader>
              <CardTitle className="text-foreground">SABnzbd Settings</CardTitle>
              <CardDescription className="text-muted-foreground">Configure your Usenet client for automated downloads.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label className="text-foreground font-semibold">Server URL</Label>
                <Input 
                  value={sabUrl} 
                  onChange={e => { setSabUrl(e.target.value); setStatus('idle'); }} 
                  placeholder="http://192.168.1.100:8080" 
                  className="bg-muted/50 border-border focus-visible:ring-primary"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-foreground font-semibold">API Key</Label>
                <Input 
                  value={sabKey} 
                  onChange={e => { setSabKey(e.target.value); setStatus('idle'); }} 
                  placeholder="Your SABnzbd API Key" 
                  className="bg-muted/50 border-border focus-visible:ring-primary"
                />
              </div>

              <div className="flex flex-col sm:flex-row justify-between gap-3 pt-6">
                <Button variant="outline" onClick={() => handleTest('sab')} disabled={loading} className="border-border hover:bg-muted font-bold order-2 sm:order-1">
                  {loading ? <Loader2 className="animate-spin w-4 h-4 mr-2" /> : null}
                  Test Connection
                </Button>
                <Button onClick={() => handleSave('sab')} disabled={loading} className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold order-1 sm:order-2">
                  Save Settings
                </Button>
              </div>

              <div className="pt-2">
                {status === 'success' && (
                  <div className="text-green-600 dark:text-green-400 text-sm font-bold flex items-center bg-green-500/10 p-3 rounded-lg border border-green-500/20 animate-in zoom-in-95">
                    <CheckCircle2 className="w-4 h-4 mr-2"/> Connection Successful
                  </div>
                )}
                {status === 'error' && (
                  <div className="text-red-600 dark:text-red-400 text-sm font-bold flex items-center bg-red-500/10 p-3 rounded-lg border border-red-500/20 animate-in zoom-in-95">
                    <XCircle className="w-4 h-4 mr-2"/> Connection Failed
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}