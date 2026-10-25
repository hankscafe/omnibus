// @vitest-environment jsdom
// beta.010: "Mark completed" in Request Management. What the matcher and the monitor can't tie to a
// series, an admin closes here - and the requester hears about it, which Delete never told them. Only
// requests still waiting for their issue offer it: not a running download, an import, or a closed one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/interactive-search-modal', () => ({ InteractiveSearchModal: () => null }));

import { AdminRequestManagement } from '@/components/admin-request-management';

const row = (id: string, status: string, name: string, createdAt: string) => ({
    id, status, activeDownloadName: name, seriesName: name, userName: 'reader', volumeId: '101', metadataSource: 'COMICVINE',
    createdAt, updatedAt: '2026-10-21T12:00:00.000Z', retryCount: 0,
});

let fetchMock: ReturnType<typeof stubFetchRouter>;
const patches = () => fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
    fetchMock = stubFetchRouter([
        ['/api/admin/requests', (_url, init) => init?.method === 'PATCH'
            ? ok({ success: true, completed: JSON.parse(init.body).ids.length, skipped: [] })
            : ok([
                row('r1', 'NOT_FOUND', 'Saga #61', '2026-10-24T12:00:00.000Z'),
                row('r2', 'STALLED', 'Spawn #360', '2026-10-23T12:00:00.000Z'),
                row('r3', 'DOWNLOADING', 'X-Men #5', '2026-10-22T12:00:00.000Z'),
                row('r4', 'COMPLETED', 'Batman #1', '2026-10-21T12:00:00.000Z'),
            ])],
    ]);
});

const tableRow = (name: string) => screen.getAllByText(name).map(el => el.closest('tr')).find(Boolean) as HTMLElement;

describe('Request Management: Mark completed', () => {
    it('offers it only on requests still waiting for their issue', async () => {
        await act(async () => { render(<AdminRequestManagement />); });

        expect(within(tableRow('Saga #61')).getByTitle('Mark completed')).toBeTruthy();
        expect(within(tableRow('Spawn #360')).getByTitle('Mark completed')).toBeTruthy();
        expect(within(tableRow('X-Men #5')).queryByTitle('Mark completed')).toBeNull();
        expect(within(tableRow('Batman #1')).queryByTitle('Mark completed')).toBeNull();
    });

    it('marks one request completed and tells the requester by default', async () => {
        await act(async () => { render(<AdminRequestManagement />); });

        await act(async () => { fireEvent.click(within(tableRow('Saga #61')).getByTitle('Mark completed')); });
        expect(screen.getByRole('checkbox', { name: 'Tell the requester' }).getAttribute('aria-checked')).toBe('true');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Completed' })); });

        expect(patches()).toEqual([{ action: 'complete', ids: ['r1'], notify: true }]);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Marked completed' }));
    });

    it('marks the selected requests that are still waiting, quietly when the admin unticks the box', async () => {
        await act(async () => { render(<AdminRequestManagement />); });

        // The header box selects the whole page; only the two waiting requests can be marked.
        await act(async () => { fireEvent.click(screen.getAllByRole('checkbox')[0]); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Mark completed \(2\)/ })); });
        await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Tell the requester' })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark Completed' })); });

        expect(patches()).toEqual([{ action: 'complete', ids: ['r1', 'r2'], notify: false }]);
    });
});
