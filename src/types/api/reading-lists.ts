// src/types/api/reading-lists.ts
//
// GET /api/reading-lists - every list the user can see (their own, global ones, ownerless ones), newest
// first, with item counts and no items. Read by the reading lists page, the library, the reader and the
// Profile page. (?id= returns one list with its items - typed separately.)
import type { Jsonified } from './json';

/** One list, as the route builds it. */
export interface ReadingListSummaryRow {
    id: string;
    name: string;
    description: string | null;
    coverUrl: string | null;
    isGlobal: boolean;
    userId: string | null;
    shareId: string | null;
    updatedAt: Date;
    /** The creator (labels a global list); null for an ownerless one. */
    user: { username: string } | null;
    /** Items the user can see / of those, with a file / of those, finished by the user. */
    counts: { total: number; owned: number; read: number };
}

/** What a page receives. */
export type ReadingListSummary = Jsonified<ReadingListSummaryRow>;
