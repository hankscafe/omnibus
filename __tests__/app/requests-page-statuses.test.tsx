// @vitest-environment jsdom
// My Requests: "searched everywhere, nothing yet" (NOT_FOUND) and "released, no date known"
// (AWAITING_RELEASE) are told apart, both sit under the Awaiting tab, and the requester can cancel either.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// One object for the whole file: the page refetches whenever `session` changes identity.
const sessionValue = vi.hoisted(() => ({ data: { user: { id: 'user_1', role: 'USER' } }, status: 'authenticated' }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionValue }));

import RequestsPage from '@/app/requests/page';

const mine = (id: string, status: string, name: string) => ({
    id, status, seriesName: name, activeDownloadName: name, createdAt: '2026-10-12T12:00:00.000Z', imageUrl: null,
});

describe('My Requests: the waiting states', () => {
    beforeEach(() => {
        stubFetchRouter([
            ['/api/request', () => ok([
                mine('r1', 'NOT_FOUND', 'Saga #61'),
                mine('r2', 'AWAITING_RELEASE', 'The Dogsitter #2'),
                mine('r3', 'MANUAL_DDL', 'X-Men #5'),
                mine('r4', 'STALLED', 'Spawn #360'),
            ])],
        ]);
    });

    it('labels and explains each waiting state', async () => {
        await act(async () => { render(<RequestsPage />); });

        screen.getByText('Not Found Yet');
        screen.getByText('Awaiting Date');
        screen.getByText('GetComics Link');
        screen.getByText(/not on any source yet/i);
        screen.getByText(/no release date/i);
        expect(screen.queryByText('NOT_FOUND')).toBeNull();
        expect(screen.queryByText('AWAITING_RELEASE')).toBeNull();
    });

    it('lists both under the Awaiting tab', async () => {
        await act(async () => { render(<RequestsPage />); });
        const tab = screen.getByRole('tab', { name: 'Awaiting' });
        await act(async () => { fireEvent.mouseDown(tab); fireEvent.click(tab); });

        screen.getByText('Saga #61');
        screen.getByText('The Dogsitter #2');
        expect(screen.queryByText('X-Men #5')).toBeNull();
        expect(screen.queryByText('Spawn #360')).toBeNull();
    });

    it('lets the requester select either for cancelling', async () => {
        await act(async () => { render(<RequestsPage />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select All' })); });

        // NOT_FOUND, AWAITING_RELEASE and MANUAL_DDL are cancellable; STALLED is not.
        screen.getByText('3 Selected');
    });
});
