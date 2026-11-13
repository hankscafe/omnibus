// @vitest-environment jsdom
// The request search's detail pane (lint batch 3i, v1.4.11-beta.038): a picked result's first issue, topped
// up from /api/issue-details - its credits shown only when there are some; Request Issue posts the pane's
// issue and marks it (and, until the next ids fetch, its volume) as requested; a details reply that lands
// after Back changes nothing. And the one case the types changed: details that come back with no volume id
// (Metron's can) used to make a successful Request Issue throw - it now marks the request like any other.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'user_1', role: 'USER', canRequest: true } }, status: 'authenticated' }),
}));
const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { RequestSearch } from '@/components/request-search';

const DETAILS = {
    id: 501, volumeId: 50, name: 'Batman #1: I Am Gotham', publisher: 'DC Comics', year: '2016', image: 'b1-full.jpg',
    description: 'Gotham needs a hero.', writers: ['Tom King'], artists: ['David Finch'],
};

let fetchMock: ReturnType<typeof stubFetchRouter>;
let details: unknown;
let holdDetails: boolean;
let releaseDetails: (() => void) | null;
const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

beforeEach(() => {
    toast.mockClear();
    details = DETAILS;
    holdDetails = false;
    releaseDetails = null;
    fetchMock = stubFetchRouter([
        ['/api/library/ids', () => ok({ series: [], monitored: [], issues: [], covered: [], requests: [] })],
        ['/api/search?', () => ok({
            results: [{ id: 50, name: 'Batman', year: '2016', image: 'batman.jpg', publisher: 'DC Comics', count: 3, metadataSource: 'METRON' }],
            hasMore: false,
        })],
        ['/api/series-issues?', () => ok({ results: [{ id: 501, name: 'Batman #1', issueNumber: '1', year: '2016', image: 'b1.jpg', isReleased: true }] })],
        ['/api/issue-details?', () => holdDetails
            ? new Promise(resolve => { releaseDetails = () => resolve({ ok: true, json: async () => details }); })
            : ok(details)],
        ['/api/request', () => ok({ message: 'Queued' })],
    ]);
});

const pickBatman = async () => {
    await act(async () => { render(<RequestSearch />); });
    const input = screen.getByPlaceholderText('Search for a comic series...');
    await act(async () => { fireEvent.change(input, { target: { value: 'batman' } }); });
    await act(async () => { fireEvent.submit(input.closest('form')!); });
    await settle();
    await act(async () => { fireEvent.click(screen.getByAltText('Batman')); });
    await settle(60);
};
// The pane's own button (the issue strip's icon button has the same title).
const paneRequestIssue = () => screen.getByText('Request Issue').closest('button') as HTMLElement;
const requestBodies = () => fetchMock.mock.calls
    .filter(([u, init]) => String(u) === '/api/request' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));

describe('RequestSearch: the detail pane', () => {
    it('shows the credits the details carry, and no row for one they lack', async () => {
        await pickBatman();
        expect(await screen.findByText('Gotham needs a hero.')).toBeInTheDocument();
        expect(screen.getByText('Tom King')).toBeInTheDocument();
        expect(screen.getByText('David Finch')).toBeInTheDocument();
        expect(screen.queryByText('Cover Artist')).not.toBeInTheDocument();
        expect(screen.queryByText('Colorist')).not.toBeInTheDocument();
        expect(screen.queryByText('Letterer')).not.toBeInTheDocument();
    });

    it('Request Issue posts the issue under its volume, then shows it requested and the volume pending', async () => {
        await pickBatman();
        await screen.findByText('Gotham needs a hero.');
        expect(screen.queryByText('Pending Approval')).not.toBeInTheDocument();

        await act(async () => { fireEvent.click(paneRequestIssue()); });
        await settle();

        expect(requestBodies()).toEqual([expect.objectContaining({
            cvId: 50, name: 'Batman #1: I Am Gotham', type: 'issue', issueNumber: '1', year: '2016',
            publisher: 'DC Comics', image: 'b1-full.jpg', metadataSource: 'METRON', monitored: false, monitorOnly: false,
        })]);
        expect(screen.getAllByText('Requested').length).toBeGreaterThan(0);
        expect(screen.getByText('Pending Approval')).toBeInTheDocument();
    });

    it('details with no volume id: the request posts none, and is marked like any other', async () => {
        details = { ...DETAILS, volumeId: null };
        await pickBatman();
        await screen.findByText('Gotham needs a hero.');

        await act(async () => { fireEvent.click(paneRequestIssue()); });
        await settle();

        expect(requestBodies()[0]).toMatchObject({ cvId: null, name: 'Batman #1: I Am Gotham', type: 'issue' });
        expect(screen.getAllByText('Requested').length).toBeGreaterThan(0);
        expect(screen.getByText('Pending Approval')).toBeInTheDocument();
    });

    it('a details reply that lands after Back changes nothing', async () => {
        holdDetails = true;
        await pickBatman();
        expect(screen.queryByText('Gotham needs a hero.')).not.toBeInTheDocument();

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Back/ })); });
        await act(async () => { releaseDetails?.(); });
        await settle();

        // Still the results: the details never re-open the pane.
        expect(screen.getByAltText('Batman')).toBeInTheDocument();
        expect(screen.queryByText('Gotham needs a hero.')).not.toBeInTheDocument();
        expect(screen.queryByText('Request Issue')).not.toBeInTheDocument();
    });
});
