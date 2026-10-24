// src/lib/request-status.ts
//
// What each stored Request.status means to a person - one place for My Requests, Request Management
// and the profile's activity list, which used to hard-code their own labels (Request Management printed
// AWAITING_RELEASE and MANUAL_DDL raw).
//
// The two WAITING states are re-searched by the monitor's parked sweep every awaiting_retry_days and
// are never a health error:
//   NOT_FOUND        - searched every source, nothing had it yet (queue.ts, the engine's no-match answer);
//   AWAITING_RELEASE - the provider says the issue is out but gives no release date, so the monitor
//                      parked it without searching (a failed search later turns it into NOT_FOUND).
// Until v1.4.10-beta.007 AWAITING_RELEASE meant both; rows from before become NOT_FOUND the next time
// their re-search comes up empty.

export const WAITING_STATUSES = ['NOT_FOUND', 'AWAITING_RELEASE'] as const;

/** Statuses a requester may cancel from My Requests: nothing has been imported yet. */
export const CANCELLABLE_STATUSES: readonly string[] = ['PENDING_APPROVAL', 'PENDING', 'DOWNLOADING', 'MANUAL_DDL', 'UNRELEASED', ...WAITING_STATUSES];

const LABELS: Record<string, string> = {
    PENDING_APPROVAL: 'Needs Approval',
    PENDING: 'Pending',
    DOWNLOADING: 'Downloading',
    MANUAL_DDL: 'GetComics Link',
    IMPORTING: 'Importing…',
    IMPORTED: 'Completed',
    COMPLETED: 'Completed',
    UNRELEASED: 'Unreleased',
    AWAITING_RELEASE: 'Awaiting Date',
    NOT_FOUND: 'Not Found Yet',
    STALLED: 'Stalled',
    FAILED: 'Failed',
    ERROR: 'Error',
    NEEDS_REVIEW: 'Needs Review',
    CANCELLED: 'Cancelled',
};

/** The status as a person reads it; a status this list doesn't know shows as stored. */
export function requestStatusLabel(status: string): string {
    return LABELS[status] ?? status;
}

const DETAILS: Record<string, string> = {
    NOT_FOUND: 'Not on any source yet — searching again automatically',
    AWAITING_RELEASE: 'No release date yet — searching again automatically',
};

/** One line on what happens next, for the states where the label alone doesn't say it. */
export function requestStatusDetail(status: string): string | null {
    return DETAILS[status] ?? null;
}

const SKY = 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400 dark:border-sky-800';
const CLASSES: Record<string, string> = {
    IMPORTED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800',
    COMPLETED: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800',
    DOWNLOADING: 'bg-primary/20 text-primary border-primary/30',
    MANUAL_DDL: 'bg-primary/20 text-primary border-primary/30',
    PENDING_APPROVAL: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800',
    FAILED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
    STALLED: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
    ERROR: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
    UNRELEASED: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800',
    // Waiting is information, not failure: both states share one colour, and the label tells them apart.
    AWAITING_RELEASE: SKY,
    NOT_FOUND: SKY,
    // #240 PR B: handed to the watched folder, waiting on the sweep - active work, not an arrival.
    IMPORTING: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
    // #240: the dedupe's terminal-but-not-done state - a person has to look at the pack.
    NEEDS_REVIEW: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800',
};

/** Badge colours for a status (Tailwind classes, light and dark). */
export function requestStatusClass(status: string): string {
    return CLASSES[status] ?? 'bg-muted text-foreground border-border';
}

/** Whether a request passes a status filter ("ALL", or one stored status). Matched by label, so one
 *  filter covers the statuses that read the same (IMPORTED and COMPLETED). */
export function requestStatusMatches(status: string, filter: string): boolean {
    return filter === 'ALL' || requestStatusLabel(status) === requestStatusLabel(filter);
}

/** Request Management's status filter, in the order a person looks for them. */
export const REQUEST_STATUS_FILTERS: readonly { value: string; label: string }[] = [
    'PENDING_APPROVAL', 'PENDING', 'DOWNLOADING', 'MANUAL_DDL', 'IMPORTING', 'IMPORTED',
    'UNRELEASED', 'AWAITING_RELEASE', 'NOT_FOUND', 'STALLED', 'NEEDS_REVIEW',
].map(value => ({ value, label: requestStatusLabel(value) }));
