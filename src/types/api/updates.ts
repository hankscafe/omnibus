// src/types/api/updates.ts
//
// GET /api/library/updates - recent arrivals (file-backed issues, newest first) in the series the user
// follows: the last 30 days, at most 500. Read by the Updates page and the Profile page's Updates section.
import type { Jsonified } from './json';

/** One arrival, as the route builds it. */
export interface UpdateItemRow {
    id: string;
    seriesId: string;
    seriesName: string;
    seriesPath: string;
    number: string;
    name: string | null;
    /** Always set: the feed only takes issues with a file. */
    filePath: string;
    /** A /api/library/cover URL (provider art, the issue's own first page, or the series folder's). */
    coverUrl: string | null;
    /** When the file arrived (the field keeps its name for the page that groups by it). */
    createdAt: Date;
    isRead: boolean;
}

/** What the route builds. */
export interface UpdatesPayload {
    items: UpdateItemRow[];
    windowDays: number;
    /** True when the 500-item cap cut the window short. */
    capped: boolean;
}

/** What a page receives. */
export type UpdatesResponse = Jsonified<UpdatesPayload>;
export type UpdateItem = Jsonified<UpdateItemRow>;
