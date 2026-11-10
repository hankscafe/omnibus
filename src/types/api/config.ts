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
