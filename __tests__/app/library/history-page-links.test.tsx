// @vitest-environment jsdom
// v1.4.11-beta.030 (lint batch 3e): Reading History's entries got a real type, under which an entry's
// file path and cover can be null (a progress row can outlive its file). Two reads were rewritten to
// match: the reader link (String(filePath) - the same "null" encodeURIComponent always produced) and
// the cover (no src rather than src={null}). These tests pin what the page does with both (they pass
// on the page before the batch too).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

import HistoryPage from '@/app/library/history/page';

const entry = (over: Record<string, unknown>) => ({
    id: 'p1', seriesName: 'Saga', issueNumber: '1', filePath: '/library/Saga/Saga 001.cbz', seriesPath: '/library/Saga',
    percentage: 40, isCompleted: false, updatedAt: '2026-11-01T10:00:00.000Z', metadataId: '1', metadataSource: 'COMICVINE',
    seriesCoverUrl: '/api/library/cover?path=saga.jpg', ...over,
});

describe('Reading History - entries', () => {
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
    afterEach(() => vi.unstubAllGlobals());

    it('opens an entry in the reader, its cover shown', async () => {
        stubFetchRouter([['/api/progress/history', () => ok({ items: [entry({})] })]]);
        render(<HistoryPage />);
        fireEvent.click(await screen.findByText('Saga'));

        expect(push).toHaveBeenCalledWith(`/reader?path=${encodeURIComponent('/library/Saga/Saga 001.cbz')}&series=${encodeURIComponent('/library/Saga')}`);
        expect(document.querySelector('img')?.getAttribute('src')).toBe('/api/library/cover?path=saga.jpg');
    });

    it('keeps the old link and no cover for an entry whose file and cover are gone', async () => {
        stubFetchRouter([['/api/progress/history', () => ok({ items: [entry({ id: 'p2', seriesName: 'Gone', filePath: null, seriesCoverUrl: null })] })]]);
        render(<HistoryPage />);
        fireEvent.click(await screen.findByText('Gone'));

        expect(push).toHaveBeenCalledWith(`/reader?path=null&series=${encodeURIComponent('/library/Saga')}`);
        expect(document.querySelector('img')?.hasAttribute('src')).toBe(false);
    });
});
