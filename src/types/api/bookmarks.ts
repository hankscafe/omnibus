// src/types/api/bookmarks.ts
//
// GET /api/progress/bookmarks?path=<file> - the signed-in user's bookmarks in one issue, first page first.
// Signed out, an unknown file or a failed lookup all answer an empty list.
import type { Bookmark } from '@prisma/client';
import type { Jsonified } from './json';

export interface BookmarksPayload {
    bookmarks: Bookmark[];
}

/** What a page receives. */
export type BookmarksResponse = Jsonified<BookmarksPayload>;
