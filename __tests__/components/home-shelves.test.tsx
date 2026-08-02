// @vitest-environment jsdom
// __tests__/components/home-shelves.test.tsx
//
// Home shelves refresh wiring (2026-07-25 worklist items 1+3): both shelves must re-fetch when
// the page's refreshSignal bumps (the "Refresh Data" button previously skipped them entirely)
// and must fetch with cache: 'no-store' so imports surface without a hard reload.
import '@testing-library/jest-dom';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RecentlyAdded } from '@/components/recently-added';
import { RecommendationsShelf } from '@/components/recommendations-shelf';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

const shelfPayload = (key: 'items' | 'series') => ({
    ok: true,
    json: async () => ({
        [key]: [{ id: 's1', name: 'Alpha', year: 2026, path: '/lib/a', coverUrl: null, issueCount: 1 }],
        basedOn: 'Alpha',
    }),
});

describe('home shelves refresh wiring', () => {
    beforeEach(() => { fetchMock.mockReset(); });

    it('RecentlyAdded re-fetches with no-store when refreshSignal bumps', async () => {
        fetchMock.mockResolvedValue(shelfPayload('items'));
        // Since Beta C the shelf also fetches /api/library/follow (bell decoration), so count the
        // recent-endpoint calls specifically instead of total fetches.
        const recentCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/library/recent'));
        const { rerender } = render(<RecentlyAdded refreshSignal={0} />);
        await waitFor(() => expect(recentCalls()).toHaveLength(1));

        expect(recentCalls()[0][1]).toEqual(expect.objectContaining({ cache: 'no-store' }));

        rerender(<RecentlyAdded refreshSignal={1} />);
        await waitFor(() => expect(recentCalls()).toHaveLength(2));
    });

    it('RecommendationsShelf re-fetches with no-store when refreshSignal bumps', async () => {
        fetchMock.mockResolvedValue(shelfPayload('series'));
        const { rerender } = render(<RecommendationsShelf refreshSignal={0} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/recommendations');
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: 'no-store' }));

        rerender(<RecommendationsShelf refreshSignal={1} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });
});
