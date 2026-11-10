// src/types/api/admin.ts
//
// The admin pages' read routes: the dashboard (queue, requests, health, update check), Analytics, Logs,
// Reports, Storage, Trophies and Users. Rows the routes return straight from Prisma use its types.
import type { AuditLog, IssueReport, JobLog, Trophy } from '@prisma/client';
import type { HealthCheckResult } from '@/lib/health-checker';
import type { Jsonified } from './json';

// --- GET /api/admin/active-downloads (the dashboard's download-client queue) -------------------------

/** One download as a client reports it, normalised across qBittorrent / Transmission / Deluge / SABnzbd / NZBGet. */
export interface ActiveDownloadRow {
    /** The torrent hash or the usenet job id. */
    id: string;
    /** Transmission can leave it out. */
    name?: string;
    /** Percent, as the client gives it or "12.3". */
    progress: string;
    status: string;
    /** "123.4 MB", or the client's own size text. */
    size: string;
    clientName: string;
}

export interface ActiveDownloadsReply {
    success: boolean;
    activeDownloads: ActiveDownloadRow[];
    error?: string;
}

// --- GET /api/admin/requests[?activeOnly=true] -----------------------------------------------------

/** One request, as Request Management and the dashboard see it (everyone's, with the requester). */
export interface AdminRequestRow {
    id: string;
    userId: string;
    volumeId: string;
    metadataSource: string;
    seriesName: string;
    activeDownloadName: string | null;
    seriesPath: string | null;
    /** The requester; 'System' when the user is gone. */
    userName: string;
    createdAt: Date;
    updatedAt: Date;
    /** UNRELEASED only: the issue's release date (as stored, "YYYY-MM-DD") the Series Monitor moves it on by. */
    releaseDate: string | null;
    status: string;
    /** Why it is in that state (admins only). */
    statusNote: string | null;
    progress: number;
    downloadLink: string | null;
    imageUrl: string | null;
    retryCount: number;
}

export type AdminRequest = Jsonified<AdminRequestRow>;

// --- GET /api/admin/health -------------------------------------------------------------------------

export type { HealthCheckResult };

/** The system health report (cached; ?force=true reruns it). */
export interface HealthReport {
    status: 'HEALTHY' | 'WARNING' | 'DEGRADED';
    /** Epoch milliseconds. */
    lastRun: number;
    checks: HealthCheckResult[];
}

// --- GET /api/admin/update-check -------------------------------------------------------------------

/** A GitHub release, the fields the pages read. */
export interface GitHubRelease {
    id: number;
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    /** Null only for a draft, which an anonymous request never sees. */
    published_at: string;
    prerelease: boolean;
}

export interface UpdateCheckReply {
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion?: string;
    /** Newest first. */
    releases: GitHubRelease[];
    error?: string;
}

// --- GET /api/admin/analytics ----------------------------------------------------------------------

export interface AnalyticsPayload {
    /** The 8 biggest publishers by stored size, in GB. */
    storageData: { name: string; value: number }[];
    /** The 5 users with the most read progress. */
    engagementData: { name: string; count: number }[];
    /** Scan / sync / monitor / diagnostics jobs per day, the last 30 days. */
    healthData: { date: string; success: number; fail: number }[];
    /** The 5 most-favourited series. */
    popularSeriesData: { name: string; completedCount: number }[];
    /** 10 series nobody has favourited. */
    inactiveSeries: { id: string; name: string; publisher: string }[];
    timestamp: string;
}

// --- GET /api/admin/logs, /api/admin/job-logs, /api/admin/audit-logs ---------------------------------

/** A line of the in-memory server log. */
export interface LiveLogEntry {
    timestamp: string;
    message: string;
    type: 'info' | 'error' | 'success' | 'warn' | 'debug';
}

export type JobLogEntry = Jsonified<JobLog>;
export type AuditLogRow = AuditLog & { user: { username: string } | null };
export type AuditLogEntry = Jsonified<AuditLogRow>;

// --- GET /api/admin/reports ------------------------------------------------------------------------

export type IssueReportRow = IssueReport & { user: { username: string }; series: { name: string; folderPath: string } };
export type IssueReportEntry = Jsonified<IssueReportRow>;

// --- GET /api/admin/storage ------------------------------------------------------------------------

/** One series in the engine's storage deep-dive (diagnostics.rs StorageEntry), largest first. */
export interface StorageSeriesEntry {
    id: string;
    name: string;
    publisher: string;
    isManga: boolean;
    issueCount: number;
    path: string;
    sizeBytes: number;
}

export interface StorageReply {
    series: StorageSeriesEntry[];
    /** When the deep-dive last ran (epoch milliseconds, as text); null before the first run. */
    lastRun: string | null;
    /** No deep-dive yet: the page offers to start one. */
    needsScan?: boolean;
    error?: string;
}

// --- GET /api/trophies -----------------------------------------------------------------------------

export type TrophyEntry = Jsonified<Trophy>;

// --- GET /api/admin/users, /api/admin/libraries ------------------------------------------------------

/** One account on the Users page: GET /api/admin/users lists these; PATCH answers `{ success, user }` and
 *  POST the new account, in this shape. Never the password hash, TOTP secret or sessionVersion. */
export interface AdminUserRow {
    id: string;
    username: string;
    email: string;
    role: string;
    isApproved: boolean;
    autoApproveRequests: boolean;
    canRequest: boolean;
    canDownload: boolean;
    canCreateGlobalLists: boolean;
    createdAt: Date;
    twoFactorEnabled: boolean;
    /** The libraries the user may open. */
    libraryAccess: { libraryId: string }[];
}

export type AdminUser = Jsonified<AdminUserRow>;

/** A library, as the Users page's access picker lists it. */
export interface AdminLibraryOption {
    id: string;
    name: string;
    isManga: boolean;
    isDefault: boolean;
}
