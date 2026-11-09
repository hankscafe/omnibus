// @vitest-environment jsdom
// The request search's details fetch: picking a result loads its first issue's details once, from
// the result's own provider. The effect is keyed on the id, issue-or-volume and the provider - NOT
// on the whole selection, because it rewrites the selection with the answer (here the answer has no
// volume id, which a selection-keyed effect would see as a change and fetch again, and again).
// The route reads id, type and provider only, so the request carries nothing else.
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

global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { RequestSearch } from '@/components/request-search';

let fetchMock: ReturnType<typeof stubFetchRouter>;
const settle = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const detailsCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter(u => u.startsWith('/api/issue-details'));

describe('RequestSearch: the details of a picked result', () => {
    beforeEach(() => {
        toast.mockClear();
        fetchMock = stubFetchRouter([
            ['/api/library/ids', () => ok({ series: [], monitored: [], issues: [], covered: [], requests: [] })],
            ['/api/search?', () => ok({
                results: [{ id: 50, name: 'Batman', year: '2016', image: 'batman.jpg', publisher: 'DC Comics', count: 3, metadataSource: 'METRON' }],
                hasMore: false,
            })],
            ['/api/series-issues?', () => ok({ results: [{ id: 501, name: 'Batman #1', issueNumber: '1', year: '2016', image: 'b1.jpg' }] })],
            // The answer carries no volume id (Metron's can come back without one) and its own name.
            ['/api/issue-details?', () => ok({ id: 501, name: 'Batman #1: I Am Gotham', volumeId: null, description: 'Gotham needs a hero.' })],
        ]);
    });

    it('fetches the details once, from the result provider, and the answer does not fetch them again', async () => {
        await act(async () => { render(<RequestSearch />); });
        const input = screen.getByPlaceholderText('Search for a comic series...');
        await act(async () => { fireEvent.change(input, { target: { value: 'batman' } }); });
        await act(async () => { fireEvent.submit(input.closest('form')!); });
        await settle(25);

        await act(async () => { fireEvent.click(screen.getByAltText('Batman')); });
        await settle(50);
        await settle(50);

        expect(await screen.findByText('Gotham needs a hero.')).toBeInTheDocument();
        await settle(50);
        const calls = detailsCalls();
        expect(calls).toHaveLength(1);
        const url = new URL(calls[0], 'http://localhost');
        expect(url.searchParams.get('id')).toBe('501');
        expect(url.searchParams.get('type')).toBe('issue');
        expect(url.searchParams.get('provider')).toBe('METRON');
        expect(url.searchParams.has('volId')).toBe(false);
    });

    // The results grid and the volume's issue strip can be long: their covers load as they near the
    // screen. The picked comic's own cover is on screen at once, so it doesn't wait.
    it('loads the result and issue-strip covers lazily, and the picked cover at once', async () => {
        await act(async () => { render(<RequestSearch />); });
        const input = screen.getByPlaceholderText('Search for a comic series...');
        await act(async () => { fireEvent.change(input, { target: { value: 'batman' } }); });
        await act(async () => { fireEvent.submit(input.closest('form')!); });
        await settle(25);

        const result = screen.getByAltText('Batman');
        expect(result).toHaveAttribute('loading', 'lazy');
        expect(result).toHaveAttribute('decoding', 'async');

        await act(async () => { fireEvent.click(result); });
        await screen.findByText('Gotham needs a hero.');

        // The strip shows the volume's issue under its list name; the picked cover took the details' name.
        const strip = screen.getByAltText('Batman #1');
        expect(strip).toHaveAttribute('loading', 'lazy');
        expect(strip).toHaveAttribute('decoding', 'async');
        expect(screen.getByAltText('Batman #1: I Am Gotham')).not.toHaveAttribute('loading', 'lazy');
    });
});
