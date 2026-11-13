// @vitest-environment jsdom
// Continue Reading (lint batch 3i, v1.4.11-beta.038): each started issue's cover is looked up by its
// series' provider id (none to look up: the series cover stays), a card opens the reader on its file, and
// Unread takes it off the shelf. A progress row can outlive its file; its card still links, as `path=null`.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { ContinueReading } from '@/components/ContinueReading';

const SAGA = {
    id: 'p1', seriesName: 'Saga', issueNumber: '12', filePath: '/lib/Saga/Saga #012.cbz', seriesPath: '/lib/Saga',
    currentPage: 5, totalPages: 20, percentage: 25, metadataId: '4242', metadataSource: 'COMICVINE',
    seriesCoverUrl: '/api/library/cover?path=saga',
};
const LOST = {
    id: 'p2', seriesName: 'Lost Girls', issueNumber: '3', filePath: null, seriesPath: '/lib/Lost Girls',
    currentPage: 2, totalPages: 30, percentage: 7, metadataId: null, metadataSource: 'METRON',
    seriesCoverUrl: '/api/library/cover?path=lost',
};

let fetchMock: ReturnType<typeof stubFetchRouter>;
beforeEach(() => {
    push.mockClear();
    sessionStorage.clear();
    fetchMock = stubFetchRouter([
        ['/api/progress/recent', () => ok({ items: [SAGA, LOST] })],
        ['/api/series-issues?', () => ok({ results: [
            { id: 11, issueNumber: '11', issue_number: '11', image: '/cv/saga-11.jpg' },
            { id: 12, issueNumber: '12', issue_number: '12', image: '/cv/saga-12.jpg' },
        ] })],
        ['/api/progress/unread', () => ok({ success: true })],
    ]);
});

const renderShelf = async () => {
    await act(async () => { render(<ContinueReading />); });
    await act(async () => { await new Promise(r => setTimeout(r, 25)); });
};
const seriesIssueCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter(u => u.startsWith('/api/series-issues'));

describe('Continue Reading', () => {
    it("finds an issue's cover by its series' provider id; with no id the series cover stays", async () => {
        await renderShelf();
        expect(seriesIssueCalls()).toEqual(['/api/series-issues?volumeId=4242&provider=COMICVINE']);
        expect(screen.getByAltText('Saga')).toHaveAttribute('src', '/cv/saga-12.jpg');
        expect(screen.getByAltText('Lost Girls')).toHaveAttribute('src', '/api/library/cover?path=lost');
    });

    it('a card opens the reader on its file and series', async () => {
        await renderShelf();
        await act(async () => { fireEvent.click(screen.getByAltText('Saga')); });
        expect(push).toHaveBeenLastCalledWith('/reader?path=%2Flib%2FSaga%2FSaga%20%23012.cbz&series=%2Flib%2FSaga');

        await act(async () => { fireEvent.click(screen.getAllByText('Resume')[0].closest('button') as HTMLElement); });
        expect(push).toHaveBeenLastCalledWith('/reader?path=%2Flib%2FSaga%2FSaga%20%23012.cbz&series=%2Flib%2FSaga');
    });

    it('a progress row whose file is gone still links, as path=null', async () => {
        await renderShelf();
        await act(async () => { fireEvent.click(screen.getByAltText('Lost Girls')); });
        expect(push).toHaveBeenLastCalledWith('/reader?path=null&series=%2Flib%2FLost%20Girls');
    });

    it('Unread posts the progress id and takes the card off the shelf', async () => {
        await renderShelf();
        await act(async () => { fireEvent.click(screen.getAllByText('Unread')[0].closest('button') as HTMLElement); });
        const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/progress/unread');
        expect(JSON.parse(call![1].body)).toEqual({ progressId: 'p1' });
        expect(screen.queryByAltText('Saga')).not.toBeInTheDocument();
        expect(screen.getByAltText('Lost Girls')).toBeInTheDocument();
    });
});
