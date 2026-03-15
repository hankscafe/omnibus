"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ArrowLeft, Webhook, Terminal, Copy, Check, FileJson, Play, Loader2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/components/ui/use-toast"

export default function ApiGuidePage() {
  const [copied, setCopied] = useState(false);
  const [apiKey, setApiKey] = useState<string>("");
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  
  const { toast } = useToast();

  useEffect(() => {
    document.title = "Omnibus - API Guide";
    
    // Fetch the actual API key so the Live Tester works instantly
    fetch('/api/admin/config')
      .then(res => res.json())
      .then(data => {
        if (data.settings && Array.isArray(data.settings)) {
          const keySetting = data.settings.find((s: any) => s.key === 'omnibus_api_key');
          if (keySetting) setApiKey(keySetting.value);
        }
      })
      .catch(() => {});
  }, []);

  const handleTestApi = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/v1/stats', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey
        }
      });
      const data = await res.json();
      setTestResult(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setTestResult(JSON.stringify({ error: e.message || "Failed to reach endpoint." }, null, 2));
    } finally {
      setIsTesting(false);
    }
  };

  const yamlCode = `- Media:
    - Omnibus:
        icon: omnibus.png
        href: http://your-ip:3000
        description: Comic Book Manager
        widget:
            type: customapi
            url: http://your-ip:3000/api/v1/stats
            method: GET
            headers:
                x-api-key: "your_api_key_here"
            mappings:
              - field: { data: systemHealth }
                label: Status
                format: text
              - field: { data: totalSeries }
                label: Series
                format: number
              - field: { data: totalIssues }
                label: Issues
                format: number
              - field: { data: activeDownloads }
                label: Downloads
                format: number`;

  const handleCopyYaml = () => {
    navigator.clipboard.writeText(yamlCode);
    setCopied(true);
    toast({ title: "Copied to Clipboard", description: "You can now paste this into your services.yaml" });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="container mx-auto py-10 px-6 max-w-4xl space-y-8 transition-colors duration-300">
      
      <div className="flex items-center gap-4">
        <Link href="/admin/settings">
          <Button variant="ghost" size="icon" className="hover:bg-muted text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div>
            <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
            <Webhook className="w-8 h-8 text-primary" /> Omnibus API Guide
            </h1>
            <p className="text-muted-foreground mt-1">Integrate Omnibus with third-party dashboards and tools.</p>
        </div>
      </div>

      <Card className="shadow-sm border-border bg-background">
        <CardHeader>
          <CardTitle className="text-xl">Authentication</CardTitle>
          <CardDescription>All API requests require an active API Key, which can be generated in the Settings panel.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
            <p className="text-sm text-foreground">Authentication can be handled in three ways. Pass your key using one of the following methods:</p>
            <div className="grid gap-3">
                <div className="flex items-center gap-3 bg-muted/50 p-3 rounded-lg border border-border">
                    <Badge variant="secondary" className="font-mono bg-primary/10 text-primary border-primary/30">Header</Badge>
                    <code className="text-sm font-mono font-bold text-foreground">x-api-key: YOUR_API_KEY</code>
                </div>
                <div className="flex items-center gap-3 bg-muted/50 p-3 rounded-lg border border-border">
                    <Badge variant="secondary" className="font-mono bg-primary/10 text-primary border-primary/30">Header</Badge>
                    <code className="text-sm font-mono font-bold text-foreground">Authorization: Bearer YOUR_API_KEY</code>
                </div>
                <div className="flex items-center gap-3 bg-muted/50 p-3 rounded-lg border border-border">
                    <Badge variant="secondary" className="font-mono bg-primary/10 text-primary border-primary/30">URL Param</Badge>
                    <code className="text-sm font-mono font-bold text-foreground">?apiKey=YOUR_API_KEY</code>
                </div>
            </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm border-border bg-background">
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2"><Terminal className="w-5 h-5 text-primary"/> Homepage Integration</CardTitle>
          <CardDescription className="text-muted-foreground">To display Omnibus stats on your <a href="https://gethomepage.dev" target="_blank" rel="noreferrer" className="text-primary hover:underline font-bold">Homepage</a> dashboard, use the following configuration in your <code className="bg-muted px-1 py-0.5 rounded text-foreground font-mono">services.yaml</code>.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-4 rounded-lg">
                <p className="text-sm text-amber-800 dark:text-amber-400 font-medium">
                    <strong>Note:</strong> Due to Homepage's strict YAML parsing logic for custom APIs, you must use the nested field mapping syntax <code className="bg-amber-100 dark:bg-amber-900/50 px-1 rounded font-mono">field: &#123; data: key &#125;</code> as shown in the example below.
                </p>
            </div>
            
            {/* Fully Theme-Aware Code Block */}
            <div className="relative group rounded-lg overflow-hidden border border-border bg-muted/30">
                <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
                    <span className="text-xs font-mono font-bold text-muted-foreground">services.yaml</span>
                    <Button variant="ghost" size="sm" className="h-7 text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-muted" onClick={handleCopyYaml}>
                        {copied ? <Check className="w-3.5 h-3.5 mr-1.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                        {copied ? "Copied!" : "Copy Code"}
                    </Button>
                </div>
                <pre className="p-4 overflow-x-auto text-sm font-mono text-foreground leading-relaxed">
                    <code>{yamlCode}</code>
                </pre>
            </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm border-border bg-background">
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2"><FileJson className="w-5 h-5 text-primary"/> Endpoint: /api/v1/stats</CardTitle>
          <CardDescription>Returns real-time health and usage statistics for your Omnibus instance. Methods: <Badge variant="outline" className="text-[10px] font-mono border-primary/30 text-primary">GET</Badge></CardDescription>
        </CardHeader>
        <CardContent>
            <div className="overflow-x-auto rounded-lg border border-border mb-8">
                <table className="w-full text-sm text-left">
                    <thead className="bg-muted/50 border-b border-border text-muted-foreground font-medium uppercase text-xs tracking-wider">
                        <tr>
                            <th className="px-4 py-3">JSON Field</th>
                            <th className="px-4 py-3">Type</th>
                            <th className="px-4 py-3">Description</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">systemHealth</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">string</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Status: <span className="font-semibold text-foreground">Healthy</span>, <span className="font-semibold text-foreground">Update Available</span>, or <span className="font-semibold text-foreground">Degraded</span>.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">currentVersion</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">string</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">The version of Omnibus currently running.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">latestVersion</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">string</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">The most recent version available on GitHub.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">totalSeries</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Total number of series in the library.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">totalIssues</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Total count of comic/manga files indexed.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">totalRequests</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Lifetime count of user requests.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">totalUsers</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Number of registered users.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">activeDownloads</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Count of active tasks in the download client.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">completed30d</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Successful imports in the last 30 days.</td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-3 font-mono font-bold text-foreground">failed30d</td>
                            <td className="px-4 py-3"><Badge variant="secondary" className="font-mono text-[10px] bg-muted text-muted-foreground border-border">number</Badge></td>
                            <td className="px-4 py-3 text-muted-foreground">Total failed/error tasks in the last 30 days.</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            {/* --- LIVE API TESTER --- */}
            <div className="pt-6 border-t border-border space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-bold text-foreground">Live API Tester</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">Ping your server locally to verify the response payload.</p>
                    </div>
                    <Button 
                        onClick={handleTestApi} 
                        disabled={isTesting || !apiKey} 
                        className="font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm w-full sm:w-auto"
                    >
                        {isTesting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2 fill-current" />}
                        Test Endpoint
                    </Button>
                </div>
                
                {!apiKey && (
                    <div className="text-sm text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 p-4 rounded-lg border border-orange-200 dark:border-orange-900/50 font-medium flex items-center gap-2">
                        <Terminal className="w-5 h-5 shrink-0" />
                        You must generate an API Key in the Settings panel before you can test this endpoint.
                    </div>
                )}

                {testResult && (
                    <div className="relative rounded-lg overflow-hidden border border-border bg-muted/30 animate-in fade-in slide-in-from-top-2 shadow-inner">
                        <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
                            <span className="text-xs font-mono font-bold text-muted-foreground">JSON Response</span>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground hover:bg-background" onClick={() => setTestResult(null)}>
                                <X className="w-4 h-4" />
                            </Button>
                        </div>
                        <pre className="p-4 overflow-x-auto text-xs sm:text-sm font-mono text-foreground leading-relaxed max-h-[400px]">
                            <code>{testResult}</code>
                        </pre>
                    </div>
                )}
            </div>
        </CardContent>
      </Card>
    </div>
  )
}