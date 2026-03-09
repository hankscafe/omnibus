"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, ArrowLeft, Rocket, Github, History, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import Link from "next/link"

export default function SystemUpdatesPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = "Omnibus - System Updates";
    fetch('/api/admin/update-check')
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="container mx-auto py-10 px-6 max-w-4xl space-y-8 transition-colors duration-300">
      
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild className="hover:bg-muted text-foreground">
          <Link href="/admin"><ArrowLeft className="w-5 h-5" /></Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3 text-foreground">
            <Rocket className="w-8 h-8 text-primary" /> System Updates
          </h1>
          <p className="text-muted-foreground mt-1">
            Current Version: <strong className="text-foreground">v{data?.currentVersion}</strong>
          </p>
        </div>
      </div>

      {data?.error && (
        <Alert variant="destructive" className="bg-red-50/50 dark:bg-red-900/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Update Check Failed</AlertTitle>
          <AlertDescription>
            Could not communicate with GitHub to fetch the latest releases. This is usually due to API rate limits and will resolve itself shortly.
          </AlertDescription>
        </Alert>
      )}

      {data?.updateAvailable && data?.releases?.length > 0 && (
        <Card className="border-primary bg-primary/5 shadow-md">
          <CardContent className="p-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
            <div>
              <Badge className="bg-primary text-primary-foreground mb-2 font-bold uppercase tracking-widest">Update Available</Badge>
              <h2 className="text-2xl font-black text-foreground">Version {data.latestVersion} is ready!</h2>
              <p className="text-sm text-muted-foreground mt-1">To update, pull the latest image using Docker and restart your container.</p>
            </div>
            <div className="flex flex-col gap-2 w-full sm:w-auto">
              <code className="bg-background border border-border p-3 rounded text-xs font-mono select-all shadow-inner text-primary block text-center sm:text-left">
                docker pull ghcr.io/hankscafe/omnibus:latest
              </code>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <h2 className="text-xl font-bold flex items-center gap-2 border-b border-border pb-2 text-foreground">
            <History className="w-5 h-5 text-muted-foreground" /> Release History
        </h2>
        
        <div className="space-y-6">
          {!data?.releases || data.releases.length === 0 ? (
            <div className="text-center py-10 border-2 border-dashed border-border rounded-xl text-muted-foreground bg-muted/20">
              No release history found.
            </div>
          ) : (
            data.releases.map((release: any, index: number) => {
               const isLatest = index === 0;
               // Safely strip the "v" prefix using regex to ensure accurate comparison
               const isCurrent = release.tag_name.replace(/^v/, '') === data.currentVersion;

               return (
                <Card key={release.id} className={`shadow-sm border-border bg-background transition-all ${isLatest && data.updateAvailable ? 'border-primary/50' : ''}`}>
                  <CardHeader className="bg-muted/30 border-b border-border pb-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <CardTitle className="text-xl text-foreground">{release.name || release.tag_name}</CardTitle>
                        {isCurrent && <Badge variant="outline" className="border-green-500 text-green-600 bg-green-50 dark:bg-green-900/20">Current Version</Badge>}
                        {isLatest && data.updateAvailable && <Badge className="bg-primary text-primary-foreground">Latest</Badge>}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono shrink-0">
                        {new Date(release.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="p-6">
                    {/* whitespace-pre-wrap allows basic github markdown to render readably without a heavy markdown library */}
                    <div className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed font-sans">
                      {release.body || "No release notes provided."}
                    </div>
                    <div className="mt-6 pt-4 border-t border-border">
                      <Button variant="outline" size="sm" asChild className="border-border hover:bg-muted text-foreground">
                        <a href={release.html_url} target="_blank" rel="noopener noreferrer">
                          <Github className="w-4 h-4 mr-2" /> View on GitHub
                        </a>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
               )
            })
          )}
        </div>
      </div>

    </div>
  )
}