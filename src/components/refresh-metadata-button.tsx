"use client"
// A series' Refresh Metadata button (Metron beta 4). With the "per-issue credits" setting off, a refresh
// doesn't fetch per-issue Metron credits (writers, artists, characters, story titles - one Metron
// request per issue), so when issues on disk are missing them the button asks first, with the count,
// and the refresh carries the answer. Nothing to ask (a ComicVine series, the setting on, nothing
// missing, or the count couldn't be read) = a plain refresh, as before.
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"
import { Loader2, RefreshCw } from "lucide-react"

type Props = { metadataId: string; metadataSource: string; folderPath: string; className?: string };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function RefreshMetadataButton({ metadataId, metadataSource, folderPath, className }: Props) {
    const { toast } = useToast();
    const [busy, setBusy] = useState(false);
    const [askCount, setAskCount] = useState<number | null>(null);

    const refresh = async (fetchCredits: boolean) => {
        setAskCount(null);
        setBusy(true);
        toast({ title: "Sync Queued", description: "Metadata is being refreshed in the background." });
        try {
            const res = await fetch('/api/library/refresh-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ metadataId, metadataSource, folderPath, ...(fetchCredits ? { fetchCredits: true } : {}) }),
            });
            if (res.ok) {
                toast({ title: "Task Queued", description: "You will receive a notification when the sync is complete." });
            } else {
                const err = await res.json().catch(() => ({}));
                toast({ title: "Refresh Failed", description: err.error, variant: "destructive" });
            }
        } catch (e) {
            toast({ title: "Error", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
        } finally {
            setBusy(false);
        }
    };

    const start = async () => {
        setBusy(true);
        let missing = 0;
        try {
            const res = await fetch(`/api/library/refresh-metadata?metadataId=${encodeURIComponent(metadataId)}&metadataSource=${encodeURIComponent(metadataSource)}`);
            if (res.ok) {
                const body = await res.json();
                if (!body.creditsEnabled) missing = Number(body.missingCredits) || 0;
            }
        } catch { /* couldn't count - refresh without asking (and without credits) */ }
        setBusy(false);
        if (missing > 0) setAskCount(missing);
        else await refresh(false);
    };

    const n = askCount ?? 0;
    return (
        <>
            <Button
                variant="secondary"
                className={className ?? "w-full transition-all shadow-sm active:scale-95 border-border hover:bg-muted text-foreground font-bold"}
                disabled={busy}
                onClick={start}
            >
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                Refresh Metadata
            </Button>

            <Dialog open={askCount !== null} onOpenChange={(open) => { if (!open) setAskCount(null); }}>
                <DialogContent className="sm:max-w-[480px] bg-background border-border rounded-xl">
                    <DialogHeader>
                        <DialogTitle className="text-foreground">Also fetch per-issue credits?</DialogTitle>
                        <DialogDescription className="pt-2 text-muted-foreground">
                            {`${plural(n, 'issue', 'issues')} you have on disk ${n === 1 ? 'is' : 'are'} missing writers, artists, characters and story titles. Fetching them costs about ${plural(n, 'Metron request', 'Metron requests')} (one per issue, only once), counted against your Metron daily limit.`}
                        </DialogDescription>
                    </DialogHeader>
                    <p className="text-xs text-muted-foreground">
                        {"\"Metron: Fetch Per-Issue Credits\" is off in Settings → Metadata, so a refresh only fetches them when you say so here. Opening an issue also fetches its own."}
                    </p>
                    <DialogFooter className="mt-2 gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setAskCount(null)} className="border-border hover:bg-muted text-foreground">Cancel</Button>
                        <Button variant="secondary" onClick={() => refresh(false)} className="font-bold">Refresh only</Button>
                        <Button onClick={() => refresh(true)} className="font-bold bg-primary hover:bg-primary/90 text-primary-foreground">Refresh + fetch credits</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
