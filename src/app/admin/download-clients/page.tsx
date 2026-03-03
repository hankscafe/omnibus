"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2, XCircle } from "lucide-react"

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

  useEffect(() => {
    fetch('/api/settings/downloaders').then(res => res.json()).then(data => {
      if (data.qbit_url) setQbitUrl(data.qbit_url)
      if (data.qbit_username) setQbitUser(data.qbit_username)
      if (data.sab_url) setSabUrl(data.sab_url)
      if (data.sab_apikey) setSabKey(data.sab_apikey)
    })
  }, [])

  const handleTest = async (type: 'qbit' | 'sab') => {
    setLoading(true); setStatus('idle');
    const body = type === 'qbit' 
      ? { type, testOnly: true, url: qbitUrl, username: qbitUser, password: qbitPass }
      : { type, testOnly: true, url: sabUrl, apiKey: sabKey };

    try {
      const res = await fetch('/api/settings/downloaders', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      const data = await res.json();
      setStatus(data.success ? 'success' : 'error');
    } catch {
      setStatus('error');
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
      await fetch('/api/settings/downloaders', { method: 'POST', body: JSON.stringify(body) });
      alert("Saved!");
    } catch {
      alert("Failed to save");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container max-w-2xl mx-auto py-10 space-y-8">
      <h1 className="text-3xl font-bold">Download Clients</h1>
      
      <Tabs defaultValue="qbit" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="qbit">qBittorrent</TabsTrigger>
          <TabsTrigger value="sab">SABnzbd</TabsTrigger>
        </TabsList>

        {/* qBittorrent Tab */}
        <TabsContent value="qbit">
          <Card>
            <CardHeader>
              <CardTitle>qBittorrent Settings</CardTitle>
              <CardDescription>Configure your torrent client.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label>URL</Label>
                <Input value={qbitUrl} onChange={e => setQbitUrl(e.target.value)} placeholder="http://localhost:8080" />
              </div>
              <div className="grid gap-2">
                <Label>Username</Label>
                <Input value={qbitUser} onChange={e => setQbitUser(e.target.value)} placeholder="admin" />
              </div>
              <div className="grid gap-2">
                <Label>Password</Label>
                <Input type="password" value={qbitPass} onChange={e => setQbitPass(e.target.value)} placeholder="Enter password..." />
              </div>

              <div className="flex justify-between pt-4">
                <Button variant="outline" onClick={() => handleTest('qbit')} disabled={loading}>
                  {loading ? <Loader2 className="animate-spin w-4 h-4" /> : "Test Connection"}
                </Button>
                <Button onClick={() => handleSave('qbit')}>Save Settings</Button>
              </div>
              {status === 'success' && <div className="text-green-600 text-sm flex items-center"><CheckCircle2 className="w-4 h-4 mr-2"/> Connection Successful</div>}
              {status === 'error' && <div className="text-red-600 text-sm flex items-center"><XCircle className="w-4 h-4 mr-2"/> Connection Failed</div>}
            </CardContent>
          </Card>
        </TabsContent>

        {/* SABnzbd Tab */}
        <TabsContent value="sab">
          <Card>
            <CardHeader>
              <CardTitle>SABnzbd Settings</CardTitle>
              <CardDescription>Configure your Usenet client.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label>URL</Label>
                <Input value={sabUrl} onChange={e => setSabUrl(e.target.value)} placeholder="http://localhost:8080" />
              </div>
              <div className="grid gap-2">
                <Label>API Key</Label>
                <Input value={sabKey} onChange={e => setSabKey(e.target.value)} placeholder="Your SABnzbd API Key" />
              </div>

              <div className="flex justify-between pt-4">
                <Button variant="outline" onClick={() => handleTest('sab')} disabled={loading}>
                  {loading ? <Loader2 className="animate-spin w-4 h-4" /> : "Test Connection"}
                </Button>
                <Button onClick={() => handleSave('sab')}>Save Settings</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}