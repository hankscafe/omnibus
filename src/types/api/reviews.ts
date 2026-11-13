// src/types/api/reviews.ts
//
// GET /api/reviews?seriesId=<id> - a series' community reviews, newest first, with their average.
import type { Review } from '@prisma/client';
import type { Jsonified } from './json';

/** One review, with who wrote it. */
export interface SeriesReviewRow extends Review {
    user: { username: string; avatar: string | null };
}

/** What the route builds. */
export interface ReviewsPayload {
    reviews: SeriesReviewRow[];
    /** The average rating as text, to one decimal ("4.5"; "0.0" when there are none). */
    avgRating: string;
    total: number;
}

/** What a page receives. */
export type ReviewsResponse = Jsonified<ReviewsPayload>;
/** A reply as a page reads it: the route answers `{ error }` (with a 4xx/5xx) instead, so readers check `error` first. */
export type ReviewsReply = ReviewsResponse & { error?: string };
export type SeriesReview = Jsonified<SeriesReviewRow>;
