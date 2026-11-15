// @vitest-environment jsdom
// Calendar fix C (beta.042): the request side of a Calendar card - under "Issue #N", what the issue's
// request is doing, in the Requests pages' own words and colours, so a "Released" card says whether
// anything is fetching it.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarRequestChip, calendarRequestChip } from '@/components/calendar-request-chip';
import { requestStatusClass, requestStatusDetail, requestStatusLabel } from '@/lib/request-status';

describe('calendarRequestChip', () => {
    it("says what the request is doing, as the Requests pages say it", () => {
        for (const status of ['NOT_FOUND', 'MANUAL_DDL', 'DOWNLOADING', 'PENDING', 'PENDING_APPROVAL', 'STALLED', 'NEEDS_REVIEW']) {
            expect(calendarRequestChip('RELEASED', status)).toEqual({
                label: requestStatusLabel(status), className: requestStatusClass(status), title: requestStatusDetail(status) ?? undefined,
            });
        }
        expect(calendarRequestChip('RELEASED', 'NOT_FOUND')?.label).toBe('Not Found Yet');
        expect(calendarRequestChip('RELEASED', 'NOT_FOUND')?.title).toBe('Not on any source yet — searching again automatically');
    });

    it('reads an UNRELEASED request as "Requested" - the card already says the issue isn\'t out', () => {
        const chip = calendarRequestChip('UNRELEASED', 'UNRELEASED');
        expect(chip?.label).toBe('Requested');
        expect(chip?.className).toBe(requestStatusClass('UNRELEASED'));
        expect(chip?.title).toMatch(/searches for it once it's out/);
    });

    it('marks a released issue nobody has requested', () => {
        expect(calendarRequestChip('RELEASED', null)?.label).toBe('Not requested');
        expect(calendarRequestChip('RELEASED', undefined)?.label).toBe('Not requested');
    });

    it('shows nothing for an issue in the library, or an upcoming one with no request yet', () => {
        expect(calendarRequestChip('IN_LIBRARY', 'DOWNLOADING')).toBeNull();
        expect(calendarRequestChip('IN_LIBRARY', null)).toBeNull();
        expect(calendarRequestChip('UNRELEASED', null)).toBeNull();
        expect(calendarRequestChip(undefined, null)).toBeNull();
    });
});

describe('CalendarRequestChip', () => {
    it('renders the label with its colours and tooltip', () => {
        render(<CalendarRequestChip state="RELEASED" status="MANUAL_DDL" />);
        const chip = screen.getByTestId('calendar-request-chip');
        expect(chip.textContent).toBe('GetComics Link');
        for (const cls of requestStatusClass('MANUAL_DDL').split(' ')) expect(chip.className).toContain(cls);
    });

    it('renders nothing when there is nothing to say', () => {
        const { container } = render(<CalendarRequestChip state="IN_LIBRARY" status="IMPORTED" />);
        expect(container.innerHTML).toBe('');
    });
});
