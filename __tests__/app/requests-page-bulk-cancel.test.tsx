// @vitest-environment jsdom
// My Requests → Select → Cancel Selected (same defect class as the dashboard's bulk approve, found
// in the v1.4.7 permission sweep): it announced "Successfully cancelled N" and painted every
// selected card CANCELLED whatever the server answered. Only the cancellations the server accepted
// may change on screen; the refused ones stay as they were, still selected.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
// One object for the whole file: the page refetches whenever `session` changes identity.
const sessionValue = vi.hoisted(() => ({ data: { user: { id: 'user_1', role: 'USER' } }, status: 'authenticated' }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionValue }));

import RequestsPage from '@/app/requests/page';

// A status badge's text, not the tab of the same name ("Pending", "Cancelled").
const badges = (label: string) => screen.queryAllByText(label).filter(el => el.getAttribute('role') !== 'tab');

const mine = (id: string, name: string) => ({
    id, status: 'PENDING', seriesName: name, activeDownloadName: name, createdAt: '2026-10-12T12:00:00.000Z', imageUrl: null,
});

describe('My Requests: bulk cancel reports what the server did', () => {
    let deleteAnswer: (id: string) => any;

    beforeEach(() => {
        toast.mockClear();
        deleteAnswer = () => ok({ success: true });
        stubFetchRouter([
            ['/api/request', (u, init) => {
                if (init?.method === 'DELETE') return deleteAnswer(new URL(u, 'http://localhost').searchParams.get('id')!);
                return ok([mine('r1', 'Batman #1'), mine('r2', 'Batman #2')]);
            }],
        ]);
    });

    const selectAllAndCancel = async () => {
        await act(async () => { render(<RequestsPage />); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select All' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel selected requests' })); });
    };

    it('all accepted → both cancelled, selection mode closed', async () => {
        await selectAllAndCancel();

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Requests Cancelled', description: 'Cancelled 2 requests.' }));
        // Labels come from src/lib/request-status.ts (the badge shows them upper-case through CSS).
        expect(badges('Cancelled')).toHaveLength(2);
        expect(screen.queryByRole('button', { name: 'Cancel selected requests' })).toBeNull();
    });

    it('a refused cancellation stays PENDING and selected, and the refusal is shown', async () => {
        deleteAnswer = (id) => id === 'r2' ? err(403, { error: 'Forbidden' }) : ok({ success: true });
        await selectAllAndCancel();

        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            variant: 'destructive', title: '1 of 2 cancellations failed', description: 'Forbidden',
        }));
        expect(badges('Cancelled')).toHaveLength(1);
        expect(badges('Pending')).toHaveLength(1);
        screen.getByText('1 Selected');
    });
});
