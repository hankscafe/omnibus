// src/components/calendar-request-chip.tsx
//
// Calendar fix C (v1.4.11-beta.042): the request side of a Calendar card. The card's corner badge says
// where the issue stands in the library (Unreleased / Released / In Library); this chip, under
// "Issue #N", says what its request is doing - in the Requests pages' own words and colours - so a
// "Released" card shows whether anything is fetching it, and why not.
import { cn } from "@/lib/utils"
import { requestStatusClass, requestStatusDetail, requestStatusLabel } from "@/lib/request-status"
import type { CalendarLibraryState } from "@/types/api/calendar"

export interface CalendarChip {
    label: string
    className: string
    title?: string
}

/** What the chip says for a row, or null for no chip: none in the library, the request's status when
 *  there is one ("Requested" while it waits for its release - the badge already says Unreleased), and
 *  "Not requested" for an issue that is out, not in the library, and has no request. */
export function calendarRequestChip(state: CalendarLibraryState | undefined, status: string | null | undefined): CalendarChip | null {
    if (state === "IN_LIBRARY") return null
    if (status === "UNRELEASED") {
        return {
            label: "Requested",
            className: requestStatusClass("UNRELEASED"),
            title: "Requested ahead of its release - the New Issue Monitor searches for it once it's out",
        }
    }
    if (status) {
        return { label: requestStatusLabel(status), className: requestStatusClass(status), title: requestStatusDetail(status) ?? undefined }
    }
    if (state === "RELEASED") {
        return {
            label: "Not requested",
            className: "bg-muted text-muted-foreground border-border",
            title: "Out, not in the library, and no request for it yet",
        }
    }
    return null
}

export function CalendarRequestChip({ state, status }: { state?: CalendarLibraryState; status?: string | null }) {
    const chip = calendarRequestChip(state, status)
    if (!chip) return null
    return (
        <span
            data-testid="calendar-request-chip"
            title={chip.title}
            className={cn("inline-block mt-1 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider", chip.className)}
        >
            {chip.label}
        </span>
    )
}
