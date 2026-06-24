// src/app/admin/upload/page.tsx
//
// Dedicated "Manual Upload" admin page. Lets admins drop comic files into the WATCHED (auto-import)
// or UNMATCHED directory straight from the browser — handy when recovering a Cloudflare-gated
// GetComics download fetched by hand, or for any admin without filesystem access to the server.
"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowLeft, UploadCloud } from "lucide-react"
import { ManualUploadPanel } from "@/components/manual-upload-dialog"

export default function ManualUploadPage() {
  return (
    <div className="container mx-auto max-w-2xl py-10 px-6 transition-colors duration-300">
      <div className="flex items-start gap-4 mb-8">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 mt-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          asChild
        >
          <Link href="/admin">
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-extrabold flex items-center gap-3 text-foreground">
            <UploadCloud className="w-8 h-8 text-primary shrink-0" />
            Manual Upload
          </h1>
          <p className="text-muted-foreground mt-1 leading-relaxed">
            Upload comic files directly to the server. Files sent to <strong>Watched</strong> are imported and
            matched automatically; <strong>Unmatched</strong> holds them for the Smart Matcher.
          </p>
        </div>
      </div>

      <Card className="shadow-sm border-border bg-background">
        <CardContent className="p-5 sm:p-6">
          <ManualUploadPanel />
        </CardContent>
      </Card>
    </div>
  )
}
