// src/app/admin/settings/tabs/shared.tsx
//
// Pieces shared between the settings page shell (page.tsx: state, save, modals) and the
// per-tab components in this folder. The tabs are pure JSX consumers of the state bag `s`
// that page.tsx assembles — all state and handlers live there, one owner per setting.
"use client"

import { CheckCircle, XCircle } from "lucide-react"

export const hosterDisplayNames: Record<string, string> = {
    'mediafire': 'MediaFire',
    'getcomics_direct': 'GetComics (Direct CDN)',
    'getcomics_main': 'GetComics (Main Server · Cloudflare)',
    'getcomics': 'GetComics (Direct)',
    'mega': 'Mega',
    'pixeldrain': 'Pixeldrain',
    'rootz': 'Rootz',
    'vikingfile': 'VikingFile',
    'terabox': 'Terabox',
    'annas_archive': "Anna's Archive"
};

// Display names for the automation Search Source priority list (distinct from file hosters above).
export const sourceDisplayNames: Record<string, string> = {
    'getcomics': 'GetComics (Direct Downloads)',
    'annas_archive': "Anna's Archive",
    'prowlarr': 'Indexers (Prowlarr)'
};

export const SYSTEM_EVENTS = [
  { id: "pending_request", label: "Pending Request", desc: "Includes requester username, cover image, and synopsis." },
  { id: "request_approved", label: "Request Approved", desc: "Includes admin username, cover image, and synopsis." },
  { id: "comic_available", label: "Comic Available", desc: "Includes requester username, cover image, and synopsis." },
  { id: "download_failed", label: "Comic Download Failed", desc: "Alerts when Prowlarr or the download client fails." },
  { id: "pending_account", label: "Pending Account", desc: "Includes new user's username, email, and registration date." },
  { id: "account_approved", label: "Account Approved", desc: "Alerts when an admin approves a new user account." },
  { id: "system_alert", label: "System Health", desc: "Triggers for disk space warnings or critical errors." },
  { id: "duplicate_files", label: "Duplicate Files Found", desc: "Alerts when new duplicate comic files are detected anywhere in the library." },
  { id: "update_available", label: "System Update Available", desc: "Alerts when a new version of Omnibus is published to GitHub." },
  { id: "library_cleanup", label: "Library Cleanup", desc: "Triggers when a series is deleted, noting if files were removed from the disk." },
  { id: "metadata_match", label: "Metadata Matched", desc: "Alerts when a series is successfully matched to ComicVine IDs." },
  { id: "job_db_backup", label: "Database Backup Complete", desc: "Notifies when the automated database backup finishes." },
  { id: "job_library_scan", label: "Library Auto-Scan Complete", desc: "Notifies when the automated library scan finishes." },
  { id: "job_metadata_sync", label: "Deep Metadata Sync Complete", desc: "Notifies when the deep metadata sync finishes processing." },
  { id: "job_issue_monitor", label: "New Issue Monitor Complete", desc: "Notifies when the monitor successfully checks for new releases." },
  { id: "job_discover_sync", label: "Discover Sync Complete", desc: "Notifies when the discover timeline and popular comics refresh." },
  { id: "job_diagnostics", label: "System Diagnostics Complete", desc: "Notifies when automated system diagnostics have been run." },
  { id: "job_cache_cleanup", label: "Cache Cleanup Complete", desc: "Notifies when the automated cache cleanup finishes." },
  { id: "job_unmatched_sweep", label: "Unmatched Sweep Matched Series", desc: "Notifies when the background sweep auto-matches unmatched series (or fails)." }
];


// --- Types (shared by page.tsx state and the tab components) ---
export interface LibraryConfig { id: string; name: string; path: string; isManga: boolean; isDefault: boolean; defaultAccess: boolean; }
export interface IndexerConfig { id: number; name: string; priority: number; seedTime: number; seedRatio: number; rss: boolean; protocol: string; }
export interface CustomHeader { id?: string; key: string; value: string; }
export interface AcronymConfig { id?: string; key: string; value: string; }
export interface ScoringRule { id: string; term: string; score: number; }
export interface ClientConfig {
    id: string;
    name: string;
    type: 'qbit' | 'sab' | 'deluge' | 'nzbget';
    protocol: 'Torrent' | 'Usenet';
    url: string;
    user: string;
    pass: string;
    apiKey?: string;
    category?: string;
    remotePath?: string;
    localPath?: string;
}
export interface WebhookConfig {
    id: string;
    name: string;
    url: string;
    events: string[];
    isActive: boolean;
    botUsername?: string;
    botAvatarUrl?: string;
}
export interface HosterAccountConfig {
    id: string;
    name: string;
    hoster: string;
    username?: string;
    password?: string;
    apiKey?: string;
    isActive: boolean;
}

// The state bag page.tsx assembles for the tab components. Collections carry their real
// element types so .map/.filter callbacks stay contextually typed; everything else is loose.
export interface SettingsBag {
    configuredLibraries: LibraryConfig[];
    configuredIndexers: IndexerConfig[];
    configuredClients: ClientConfig[];
    configuredWebhooks: WebhookConfig[];
    configuredHosters: HosterAccountConfig[];
    customHeaders: CustomHeader[];
    customAcronyms: AcronymConfig[];
    scoringRules: ScoringRule[];
    hosterPriority: { hoster: string, enabled: boolean }[];
    searchSourcePriority: { source: string, enabled: boolean }[];
    availableIndexers: any[];
    users: any[];
    apiKeys: any[];
    setTestResults: (updater: (prev: any) => any) => void;
    [key: string]: any;
}

export function StatusBox({ result }: { result: { success: boolean, text: string } | null }) {
    if (!result) return null;
    const isFailure = !result.success || result.text.includes('❌') || result.text.includes('Error') || result.text.includes('Not Found') || result.text.toLowerCase().includes('failed');

    return (
        <div className={`mt-4 p-4 rounded-md border flex items-center gap-3 transition-colors duration-300 ${!isFailure ? "border-green-200 bg-green-50/30 text-green-800 dark:border-green-900/50 dark:bg-green-900/10 dark:text-green-400" : "border-red-200 bg-red-50/30 text-red-800 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-400"}`}>
            {!isFailure ? <CheckCircle className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}
            <span className="text-sm font-medium">{result.text}</span>
        </div>
    );
}
