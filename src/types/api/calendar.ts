// src/types/api/calendar.ts
//
// GET /api/calendar?weekOffset=N[&scope=followed] - one week of releases of the monitored series (or, with
// scope=followed, the series the user follows). Each row says where it stands in the library
// (libraryState) and, since v1.4.11-beta.042, what its request is doing (requestStatus): the Calendar card
// shows both, so a "Released" issue says whether anything is fetching it.

/** UNRELEASED -> RELEASED -> IN_LIBRARY as the date passes and the file lands. */
export type CalendarLibraryState = 'UNRELEASED' | 'RELEASED' | 'IN_LIBRARY';

/** One release in the week. */
export interface CalendarRelease {
    id: string;
    seriesId: string;
    seriesName: string;
    issueNumber: string;
    issueName: string | null;
    publisher: string;
    releaseDate: string | null;
    coverUrl: string | null;
    seriesPath: string | null;
    libraryState: CalendarLibraryState;
    /** The stored status of the most recently updated request for this issue that isn't cancelled
     *  (request-status.ts says what it means); null = no such request. Annual and collected-edition rows
     *  always answer null: their requests are filed under the lane's own volume. */
    requestStatus: string | null;
}

/** The week view's reply. */
export interface CalendarWeekReply {
    startDate: string;
    endDate: string;
    releases: CalendarRelease[];
}
