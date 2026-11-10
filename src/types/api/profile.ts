// src/types/api/profile.ts
//
// The Profile page's own routes: GET /api/user/profile (the account, request stats, reading history,
// trophies), GET /api/user/analytics (the reading heatmap and the year's tops), GET /api/profile/koreader
// (the eReaders syncing progress) and GET /api/user/api-keys (the user's OPDS / KOReader keys).
import type { Request, Trophy } from '@prisma/client';
import type { Jsonified } from './json';

// --- GET /api/user/profile -------------------------------------------------------------------------

/** The signed-in account. The password column never leaves the server (beta.028): only whether there is
 *  one - an SSO account has no local password, so the page disables its 2FA and password controls. */
export interface ProfileUser {
    username: string;
    role: string;
    avatar: string | null;
    banner: string | null;
    createdAt: Date;
    isSsoUser: boolean;
}

export interface ProfileStats {
    total: number;
    active: number;
    pendingApproval: number;
    completed: number;
    failed: number;
    /** Issues the user has opened / finished. */
    historyStarted: number;
    historyCompleted: number;
    /** historyCompleted as a whole percentage of historyStarted. */
    completionRate: number;
}

/** One recently read issue. */
export interface ProfileHistoryEntry {
    id: string;
    seriesName: string;
    issueNumber: string;
    /** 0-100. */
    progress: number;
    isCompleted: boolean;
    updatedAt: Date;
    /** A /api/library/cover URL (provider art, the issue's cover, or the series folder's); null when none. */
    coverUrl: string | null;
    /** '' when the issue has no file. */
    filePath: string;
    folderPath: string;
}

/** Every trophy, with whether (and when) this user earned it. */
export type ProfileTrophy = Trophy & { earned: boolean; earnedAt: Date | null };

/** What the route builds. */
export interface ProfilePayload {
    user: ProfileUser;
    stats: ProfileStats;
    /** The five newest request rows, as stored. */
    recentRequests: Request[];
    /** The 24 most recently read issues. */
    recentHistory: ProfileHistoryEntry[];
    trophies: ProfileTrophy[];
}

/** What a page receives. */
export type ProfileResponse = Jsonified<ProfilePayload>;

// --- GET /api/user/analytics -----------------------------------------------------------------------

/** An issue read on a day of the heatmap. */
export interface HeatmapEntry {
    seriesName: string;
    seriesPath: string | null;
    issueNumber: string;
    issueName: string | null;
    coverUrl: string | null;
    /** null for a day from before per-issue tracking (attributed by the progress' last update). */
    pagesRead: number | null;
}

export interface UserAnalyticsPayload {
    /** Pages read per day (YYYY-MM-DD), the last 365 days. */
    heatmap: Record<string, number>;
    /** The issues read per day. */
    heatmapDetails: Record<string, HeatmapEntry[]>;
    totalPagesReadThisYear: number;
    /** "None" when there's nothing to rank. */
    topPublisher: string;
    topGenre: string;
    topCharacter: string;
}

/** What a page receives (no Dates inside, so the same shape). */
export type UserAnalytics = UserAnalyticsPayload;

// --- GET /api/profile/koreader ---------------------------------------------------------------------

/** One eReader, from its latest sync. */
export interface KoreaderDevice {
    deviceId: string;
    deviceName: string;
    /** The document's name, without folders or extension. */
    lastDocument: string;
    /** 0-1. */
    percentage: number;
    /** Unix seconds (KOReader's own timestamps). */
    lastSync: number;
}

// --- GET /api/user/api-keys ------------------------------------------------------------------------

/** One of the user's keys (never the key itself: only its prefix). */
export interface UserApiKeyRow {
    id: string;
    name: string;
    prefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    /** The key has a KOReader sync hash, so it also signs KOReader in (older keys don't). */
    koreaderCompatible: boolean;
}

export type UserApiKey = Jsonified<UserApiKeyRow>;
