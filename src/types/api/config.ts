// src/types/api/config.ts
//
// GET /api/admin/config - the admin settings the Settings page edits, which several other admin pages
// read single values from (naming patterns, schedules, OIDC switches). Secrets arrive masked as
// "********" (SENSITIVE_KEYS in the route); the shape is the database rows'.
import type {
    SystemSetting, Library, DownloadClient, HosterAccount, DiscordWebhook, Indexer, CustomHeader, SearchAcronym,
} from '@prisma/client';
import type { Jsonified } from './json';

/** A discord webhook row, its `events` column (a JSON array of event names) parsed. */
export type DiscordWebhookRow = Omit<DiscordWebhook, 'events'> & { events: string[] };

/** What the route builds. */
export interface AdminConfigPayload {
    settings: SystemSetting[];
    libraries: Library[];
    downloadClients: DownloadClient[];
    hosterAccounts: HosterAccount[];
    discordWebhooks: DiscordWebhookRow[];
    indexers: Indexer[];
    customHeaders: CustomHeader[];
    searchAcronyms: SearchAcronym[];
    /** The server's configured folders and database URL (password masked), for display. */
    envPaths: Record<string, string>;
}

/** What a page receives. */
export type AdminConfigResponse = Jsonified<AdminConfigPayload>;

/** One `{ key, value }` setting row. */
export type SettingRow = Jsonified<SystemSetting>;

// --- The rows as the Settings page and the setup wizard edit them (and POST back) ---------------------
// An optional field the database leaves empty arrives as null, so it's typed that way (an input shows
// it as '').

export interface LibraryConfig { id: string; name: string; path: string; isManga: boolean; isDefault: boolean; defaultAccess: boolean; }

/** POST /api/admin/prowlarr/indexers: an indexer Prowlarr offers, before the admin configures it. */
export interface ProwlarrIndexerOption { id: number; name: string; protocol: string; priority: number; rss: boolean; seedTime: number; }
export interface IndexerConfig extends ProwlarrIndexerOption { seedRatio: number; }

/** The download clients the setup dialog offers. */
export type ClientType = 'qbit' | 'sab' | 'deluge' | 'transmission' | 'nzbget';
export interface ClientConfig {
    id: string;
    name: string;
    /** A ClientType for a client set up here; the stored column is plain text. */
    type: string;
    /** 'Torrent' | 'Usenet' */
    protocol: string;
    url: string;
    /** A login is optional (Transmission without RPC authentication, SABnzbd's API key instead). */
    user: string | null;
    pass: string | null;
    apiKey?: string | null;
    category?: string | null;
    remotePath?: string | null;
    localPath?: string | null;
}
export interface WebhookConfig {
    id: string;
    name: string;
    url: string;
    events: string[];
    isActive: boolean;
    botUsername?: string | null;
    botAvatarUrl?: string | null;
}
export interface HosterAccountConfig {
    id: string;
    name: string;
    hoster: string;
    username?: string | null;
    password?: string | null;
    apiKey?: string | null;
    isActive: boolean;
}
