// src/app/admin/settings/tabs/shared.tsx
//
// Pieces shared between the settings page shell (page.tsx: state, save, modals) and the
// per-tab components in this folder. The tabs are pure JSX consumers of the state bag `s`
// that page.tsx assembles — all state and handlers live there, one owner per setting.
"use client"

import type { Dispatch, SetStateAction } from "react"
import { CheckCircle, XCircle } from "lucide-react"
import type { useToast } from "@/components/ui/use-toast"
import type { LibraryConfig, IndexerConfig, ProwlarrIndexerOption, ClientType, ClientConfig, WebhookConfig, HosterAccountConfig } from "@/types/api/config"
import type { AdminApiKey, AdminUser } from "@/types/api/admin"

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
  { id: "import_needs_review", label: "Import Needs Review", desc: "Alerts when a download finished but its issue did not reach the library." },
  { id: "download_failed", label: "Comic Download Failed", desc: "Alerts when Prowlarr or the download client fails." },
  { id: "pending_account", label: "Pending Account", desc: "Includes new user's username, email, and registration date." },
  { id: "account_approved", label: "Account Approved", desc: "Alerts when an admin approves a new user account." },
  { id: "issue_reported", label: "Issue Report Submitted", desc: "Alerts when a user reports a problem with a series from its library page." },
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
// The rows /api/admin/config sends, as the Settings page and the setup wizard edit them, live with
// the route's payload types; re-exported here for the tabs.
export type { LibraryConfig, IndexerConfig, ClientType, ClientConfig, WebhookConfig, HosterAccountConfig }
export interface CustomHeader { id?: string; key: string; value: string; }
export interface AcronymConfig { id?: string; key: string; value: string; }
export interface ScoringRule { id: string; term: string; score: number; }

/** The settings the page edits, by key. Every value is a string, as the database stores it ("true" /
 *  "false" for switches, JSON text for the *_events lists); a key that was never saved is absent. */
export type SettingsValues = Record<string, string>;

/** A connection test's answer, as the StatusBox under each test button shows it. */
export interface TestResult { success: boolean; text: string; }
/** Test answers by test name (comicvine, metron, prowlarr, clients, webhooks, smtp, ...); null = none yet. */
export type TestResults = { [test: string]: TestResult | null };

export interface HosterPriorityEntry { hoster: string; enabled: boolean; }
export interface SearchSourceEntry { source: string; enabled: boolean; }

type Setter<T> = Dispatch<SetStateAction<T>>;

// The state bag page.tsx assembles for the tab components: every piece of state and every handler the
// tabs use, typed, so a tab can only read what the page actually passes (page.tsx builds it as a
// SettingsBag, so the two can't drift apart).
export interface SettingsBag {
    // Settings values + connection tests (every tab)
    config: SettingsValues;
    setConfig: Setter<SettingsValues>;
    isSourceAvailable: (source: string) => boolean;
    /** Runs /api/admin/test with the current settings, `overrideConfig` laid over them. */
    handleTest: (type: string, overrideConfig?: Record<string, unknown>) => Promise<void>;
    testing: string | null;
    testResults: TestResults;
    setTestResults: Setter<TestResults>;
    toast: ReturnType<typeof useToast>['toast'];

    // Metadata
    cacheStats: { entries: number; bytes: number } | null;
    clearMetadataCache: () => Promise<void>;
    clearingCache: boolean;

    // Library & Files
    configuredLibraries: LibraryConfig[];
    addLibrary: () => void;
    removeLibrary: (id: string) => void;
    updateLibrary: <K extends keyof LibraryConfig>(id: string, field: K, value: LibraryConfig[K]) => void;
    setLibraryDefault: (id: string, isMangaType: boolean) => void;
    handleRestoreNamingDefaults: () => void;
    /** The server's configured folders and database URL (password masked), for display. */
    envPaths: Record<string, string>;

    // Search & Indexers
    updateProwlarrCategories: (toggledId?: string, isChecked?: boolean, newCustom?: string) => void;
    customProwlarrCategories: string;
    refreshIndexers: () => Promise<void>;
    refreshing: boolean;
    hasRefreshed: boolean;
    availableIndexers: ProwlarrIndexerOption[];
    configuredIndexers: IndexerConfig[];
    /** Opens the indexer dialog: for one Prowlarr offers (new) or one already configured (isEdit). */
    openIndexerModal: (indexer: ProwlarrIndexerOption | IndexerConfig, isEdit?: boolean) => void;
    deleteIndexer: (id: number) => void;
    scoringRules: ScoringRule[];
    setScoringRules: Setter<ScoringRule[]>;
    customAcronyms: AcronymConfig[];
    setCustomAcronyms: Setter<AcronymConfig[]>;

    // Downloads
    configuredClients: ClientConfig[];
    openClientSetup: (type: ClientType) => void;
    deleteClient: (id: string) => void;
    setEditingClient: Setter<ClientConfig | null>;
    setClientModalOpen: Setter<boolean>;
    searchSourcePriority: SearchSourceEntry[];
    moveSearchSource: (index: number, direction: -1 | 1) => void;
    toggleSearchSourceEnabled: (index: number) => void;
    hosterPriority: HosterPriorityEntry[];
    moveHosterPriority: (index: number, direction: -1 | 1) => void;
    toggleHosterEnabled: (index: number) => void;
    configuredHosters: HosterAccountConfig[];
    setAnnasKey: (value: string) => void;
    openHosterSetup: (hosterName: string) => void;
    deleteHoster: (id: string) => void;

    // Discovery & Filtering
    applyRecommendedFilters: () => void;
    applyForeignFilters: () => void;

    // Notifications
    configuredWebhooks: WebhookConfig[];
    openWebhookModal: (webhook?: WebhookConfig) => void;
    handleTestWebhook: (webhook: WebhookConfig) => Promise<void>;
    testingWebhookId: string | null;
    toggleWebhookActive: (id: string) => void;
    deleteWebhook: (id: string) => void;
    toggleProviderEvent: (providerKey: string, eventId: string) => void;

    // Access & Security
    users: AdminUser[];
    apiKeys: AdminApiKey[];
    newKeyName: string;
    setNewKeyName: Setter<string>;
    newKeyUserId: string;
    setNewKeyUserId: Setter<string>;
    newKeyExpiration: string;
    setNewKeyExpiration: Setter<string>;
    handleGenerateKey: () => Promise<void>;
    isGeneratingKey: boolean;
    generatedKey: string | null;
    setGeneratedKey: Setter<string | null>;
    generateError: string | null;
    setGenerateError: Setter<string | null>;
    handleRevokeKey: (id: string) => Promise<void>;
    copyToClipboard: (text: string) => Promise<void>;
    customHeaders: CustomHeader[];
    addHeader: (k?: string) => void;
    updateHeader: (i: number, f: 'key' | 'value', v: string) => void;
    removeHeader: (id: string) => void;
}

export function StatusBox({ result }: { result: TestResult | null }) {
    if (!result) return null;
    const isFailure = !result.success || result.text.includes('❌') || result.text.includes('Error') || result.text.includes('Not Found') || result.text.toLowerCase().includes('failed');

    return (
        <div className={`mt-4 p-4 rounded-md border flex items-center gap-3 transition-colors duration-300 ${!isFailure ? "border-green-200 bg-green-50/30 text-green-800 dark:border-green-900/50 dark:bg-green-900/10 dark:text-green-400" : "border-red-200 bg-red-50/30 text-red-800 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-400"}`}>
            {!isFailure ? <CheckCircle className="h-5 w-5 shrink-0" /> : <XCircle className="h-5 w-5 shrink-0" />}
            <span className="text-sm font-medium">{result.text}</span>
        </div>
    );
}
