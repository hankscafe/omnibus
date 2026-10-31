// @vitest-environment jsdom
// Request Management printed AWAITING_RELEASE and MANUAL_DDL raw (only three statuses had a label),
// and "searched everywhere, nothing yet" was indistinguishable from "released, no date known". Both
// lists now take their labels from src/lib/request-status.ts.
// #263: the status filter had no Cancelled (or Failed / Error), so those rows couldn't be picked out.
// And a selection outlived the filter that made it: tick the cancelled requests, switch to Completed,
// and Delete still counted the cancelled ones the list no longer showed. Changing a filter clears it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/interactive-search-modal', () => ({ InteractiveSearchModal: () => null }));

// Radix Select calls these, and jsdom has neither.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

import { AdminRequestManagement } from '@/components/admin-request-management';

const row = (id: string, status: string, name: string) => ({
    id, status, activeDownloadName: name, seriesName: name, userName: 'reader', volumeId: '101', metadataSource: 'COMICVINE',
    createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z', retryCount: 0,
});

describe('Request Management: status labels', () => {
    beforeEach(() => {
        stubFetchRouter([
            ['/api/admin/requests', () => ok([
                { ...row('r1', 'NOT_FOUND', 'Saga #61'), statusNote: 'GetComics: nothing found · Prowlarr: 12 results, none matched' },
                row('r2', 'AWAITING_RELEASE', 'The Dogsitter #2'),
                row('r3', 'MANUAL_DDL', 'X-Men #5'),
                row('r4', 'STALLED', 'Spawn #360'),
            ])],
        ]);
    });

    it('names every status instead of printing the stored value', async () => {
        await act(async () => { render(<AdminRequestManagement />); });

        expect(screen.getAllByText('Not Found Yet').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Awaiting Date').length).toBeGreaterThan(0);
        expect(screen.getAllByText('GetComics Link').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Stalled').length).toBeGreaterThan(0);
        for (const raw of ['NOT_FOUND', 'AWAITING_RELEASE', 'MANUAL_DDL', 'STALLED']) {
            expect(screen.queryByText(raw)).toBeNull();
        }
    });

    // beta.008: why it's in that state, under its status (table and phone layout).
    it("shows a request's note under its status", async () => {
        await act(async () => { render(<AdminRequestManagement />); });

        expect(screen.getAllByText('GetComics: nothing found · Prowlarr: 12 results, none matched').length).toBeGreaterThan(0);
    });
});

describe('Request Management: status filter (#263)', () => {
    let fetchMock: ReturnType<typeof stubFetchRouter>;

    beforeEach(() => {
        fetchMock = stubFetchRouter([
            ['/api/admin/requests', () => ok([
                row('r1', 'CANCELLED', 'Saga #1'),
                row('r2', 'COMPLETED', 'Saga #2'),
                row('r3', 'IMPORTED', 'Saga #3'),
                row('r4', 'STALLED', 'Saga #4'),
            ])],
        ]);
    });

    afterEach(() => vi.useRealTimers());

    // Dropdown 0 is the status filter, 1 the user filter; Radix opens them from the keyboard in jsdom.
    const pick = async (dropdown: number, label: string) => {
        await act(async () => { fireEvent.keyDown(screen.getAllByRole('combobox')[dropdown], { key: 'ArrowDown' }); });
        await act(async () => { fireEvent.click(screen.getByRole('option', { name: label })); });
    };
    const pickStatus = async (label: string) => {
        await act(async () => { render(<AdminRequestManagement />); });
        await pick(0, label);
    };
    const shown = (name: string) => screen.queryAllByText(name).length > 0;
    // The table header's box selects every request on the page.
    const selectShown = async () => {
        await act(async () => { fireEvent.click(within(screen.getByRole('table')).getAllByRole('checkbox')[0]); });
    };
    const deleteButton = () => screen.queryByRole('button', { name: /^delete \(\d+\)$/i });

    it('Cancelled shows only the cancelled requests, ready to select and delete', async () => {
        await pickStatus('Cancelled');

        expect(shown('Saga #1')).toBe(true);
        for (const other of ['Saga #2', 'Saga #3', 'Saga #4']) expect(shown(other), other).toBe(false);
    });

    it('Completed shows both completed and imported requests', async () => {
        await pickStatus('Completed');

        expect(shown('Saga #2')).toBe(true);
        expect(shown('Saga #3')).toBe(true);
        for (const other of ['Saga #1', 'Saga #4']) expect(shown(other), other).toBe(false);
    });

    it('changing the status filter clears the selection, so Delete never reaches a request the list hides', async () => {
        await pickStatus('Cancelled');
        await selectShown();
        expect(deleteButton()?.textContent).toMatch(/delete \(1\)/i);

        await pick(0, 'Completed');
        expect(deleteButton()).toBeNull();
    });

    it('a search clears it too', async () => {
        await pickStatus('Cancelled');
        await selectShown();

        await act(async () => { fireEvent.change(screen.getByPlaceholderText(/search by series/i), { target: { value: 'Saga' } }); });
        expect(deleteButton()).toBeNull();
    });

    it('and so does the user filter', async () => {
        await pickStatus('Cancelled');
        await selectShown();

        await pick(1, 'reader');
        expect(deleteButton()).toBeNull();
    });

    it('the list refreshing in the background keeps the selection', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await pickStatus('Cancelled');
        await selectShown();

        // Request Management re-reads the list every 15 seconds; a fresh list is not a filter change.
        const reads = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/admin/requests').length;
        const before = reads();
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
        expect(reads()).toBeGreaterThan(before);
        expect(deleteButton()?.textContent).toMatch(/delete \(1\)/i);
    });
});
