// src/types/api/notifications.ts
//
// GET /api/notifications - the header bell, newest first: the user's own news (requests that finished or
// need them, trophies earned, reports resolved, arrivals in followed series) and, for an admin, work
// waiting (requests and accounts to approve, open reports, stalled requests, unmatched files, finished
// sweeps). Clearing the bell (POST) marks the user's own entries seen; the admin ones last while the work does.
import type { Jsonified } from './json';

export interface BellNotificationRow {
    /** The row's own id for 'comic' / 'trophy' / 'report' (clearing sends these back); a prefixed or a
     *  fixed id for the rest. */
    id: string;
    /** 'comic', 'trophy', 'report', 'follow_updates'; for an admin also 'admin_req', 'admin_user',
     *  'admin_report', 'admin_stalled', 'admin_unmatched', 'admin_sweep'. */
    type: string;
    /** A request's status ('comic' only). */
    status?: string;
    title: string | null;
    description?: string | null;
    imageUrl: string | null;
    date: Date;
}

/** What the bell receives. */
export type BellNotification = Jsonified<BellNotificationRow>;
