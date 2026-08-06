"use client"

// #199 round 3 (CapitanoNemo78): the matcher never showed WHICH comic an exact issue ID points
// at — the admin fixed a number, hit "Refresh from number", and had to trust a bare numeric ID.
// This card resolves the currently-bound ID to its face: cover, composite title, year, and the
// headline credits, updating live as auto-map / refresh / hand-editing change the binding.
// Read-only on purpose: the dialog's fields stay SERIES defaults — the issue's own credits come
// from per-issue enrichment once imported. This is confirmation, not pre-fill.

import { useEffect, useState } from "react"
import { Loader2, BookOpen, ImageOff } from "lucide-react"

interface BoundIssueDetails {
  name?: string | null
  image?: string | null
  year?: string | null
  writers?: string[]
  artists?: string[]
  inkers?: string[]
  colorists?: string[]
  characters?: string[]
  teams?: string[]
}

/** Pure summary builder (exported for tests): the three display lines of the card. Credit
 *  groups cap at 3 names + a "+n" tail so one crowded role can't push the rest off screen. */
export function boundIssueSummary(d: BoundIssueDetails): {
  title: string | null
  creditLine: string | null
  castLine: string | null
} {
  const group = (label: string, names?: string[]) =>
    names && names.length
      ? `${label}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`
      : null
  return {
    title: d.name || null,
    creditLine:
      [group("W", d.writers), group("A", d.artists), group("I", d.inkers), group("C", d.colorists)]
        .filter(Boolean)
        .join("  ·  ") || null,
    castLine:
      [group("Ch", d.characters), group("T", d.teams)].filter(Boolean).join("  ·  ") || null,
  }
}

export default function SmartMatchBoundIssue({
  issueId,
  provider,
}: {
  /** The exact provider issue ID currently bound (auto-mapped, refreshed, or hand-typed). */
  issueId?: string
  /** COMICVINE or METRON — which provider the ID belongs to. */
  provider?: string
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle")
  const [details, setDetails] = useState<BoundIssueDetails | null>(null)

  useEffect(() => {
    const id = (issueId || "").trim()
    if (!id) {
      setState("idle")
      setDetails(null)
      return
    }
    const controller = new AbortController()
    setState("loading")
    // Debounced so hand-typing an ID doesn't fire per keystroke; the server's 24h details
    // cache makes refetching the settled value cheap.
    const t = setTimeout(() => {
      fetch(
        `/api/issue-details?id=${encodeURIComponent(id)}&type=issue&provider=${encodeURIComponent(provider || "COMICVINE")}`,
        { signal: controller.signal }
      )
        .then(async res => {
          const d = await res.json().catch(() => null)
          if (!res.ok || !d || d.error) throw new Error(d?.error || `HTTP ${res.status}`)
          return d as BoundIssueDetails
        })
        .then(d => {
          setDetails(d)
          setState("done")
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setDetails(null)
            setState("error")
          }
        })
    }, 450)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [issueId, provider])

  if (state === "idle") return null

  if (state === "loading") {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        Looking up the bound issue…
      </div>
    )
  }

  if (state === "error" || !details) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
        <ImageOff className="w-3.5 h-3.5 shrink-0" />
        Couldn&apos;t load details for this issue ID — double-check it, or refresh from the number.
      </div>
    )
  }

  const { title, creditLine, castLine } = boundIssueSummary(details)
  return (
    <div className="flex items-start gap-3 bg-muted/40 border border-border rounded-lg p-2.5">
      <div className="w-10 h-[60px] shrink-0 rounded bg-muted border border-border overflow-hidden flex items-center justify-center">
        {details.image
          ? <img src={details.image} alt="" className="w-full h-full object-cover" />
          : <BookOpen className="w-4 h-4 text-muted-foreground/40" />}
      </div>
      <div className="min-w-0 grid gap-0.5">
        <p className="text-xs font-semibold text-foreground leading-snug break-words">
          {title || "Untitled issue"}
          {details.year && details.year !== "????" && (
            <span className="ml-1.5 font-normal text-muted-foreground">({details.year})</span>
          )}
        </p>
        {creditLine && <p className="text-[11px] text-muted-foreground leading-snug break-words">{creditLine}</p>}
        {castLine && <p className="text-[11px] text-muted-foreground/80 leading-snug break-words">{castLine}</p>}
        {!creditLine && !castLine && (
          <p className="text-[11px] text-muted-foreground italic">No credit details from the provider yet.</p>
        )}
      </div>
    </div>
  )
}
