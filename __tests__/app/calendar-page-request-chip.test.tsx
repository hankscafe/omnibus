// @vitest-environment jsdom
// Calendar fix C (beta.042): the Calendar card shows, under "Issue #N", what the issue's request is doing -
// the field report's "Released" card never said whether anything was fetching it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// One object for the whole file: the page re-runs its effects whenever `session` changes identity.
const sessionValue = vi.hoisted(() => ({ data: { user: { id: 'user_1', role: 'USER' } }, status: 'authenticated' }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionValue }));

import CalendarPage from '@/app/calendar/page';

const release = (id: string, issueNumber: string, libraryState: string, requestStatus: string | null) => ({
    id, seriesId: 's1', seriesName: 'Saga', issueNumber, issueName: null, publisher: 'Image',
    releaseDate: '2026-11-11', coverUrl: null, seriesPath: '/comics/Saga', libraryState, requestStatus,
});

describe('Calendar page: the request behind each card', () => {
    beforeEach(() => {
        stubFetchRouter([
            ['/api/library/follow', () => ok({ seriesIds: [] })],
            // A non-admin learns that Metron is set up from the global pull list answering without an error.
            ['/api/calendar/global', () => ok({ releases: [] })],
            ['/api/calendar?', () => ok({
                startDate: '2026-11-08', endDate: '2026-11-14',
                releases: [
                    release('i61', '61', 'RELEASED', 'NOT_FOUND'),
                    release('i62', '62', 'RELEASED', null),
                    release('i60', '60', 'IN_LIBRARY', 'IMPORTED'),
                ],
            })],
        ]);
    });

    it("says on each card what its request is doing, and nothing on one that's in the library", async () => {
        await act(async () => { render(<CalendarPage />); });

        const chips = await screen.findAllByTestId('calendar-request-chip');
        expect(chips.map(c => c.textContent)).toEqual(['Not Found Yet', 'Not requested']);
        expect(chips[0].getAttribute('title')).toBe('Not on any source yet — searching again automatically');
        // The corner badges are as before.
        expect(screen.getAllByText('Released')).toHaveLength(2);
        screen.getByText('In Library');
    });
});
