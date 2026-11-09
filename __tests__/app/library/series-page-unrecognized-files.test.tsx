// @vitest-environment jsdom
// The series page's "Unrecognized Files Detected" panel (admin): files in the folder that aren't
// matched to a provider issue, each with a picker of the series' missing issues and a Link button
// (POST /api/library/issue/link). It picked them out by fields the series reply never had, so it
// could never appear; the reply now says which rows are unmatched (`isUnmatched`).
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const viewer = vi.hoisted(() => ({ role: 'ADMIN' }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'u1', role: viewer.role } }, status: 'authenticated' }),
}));
const params = new URLSearchParams('path=/lib/Image/Saga (2012)');
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => params,
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import SeriesPage from '@/app/library/series/page';

const FOLDER = '/lib/Image/Saga (2012)';
const issue = (id: string, n: string, file: string | null, isUnmatched: boolean) => ({
    id, cvId: isUnmatched ? null : 9000 + Number(n), name: `Saga #${n}`, isAnnual: false, isSpecial: false, specialName: null,
    attachedVolumeId: null, attachmentName: null, releaseDate: null, isCollected: false, collectionName: null, coversIssues: null,
    parsedNum: Number(n), number: n, fullPath: file, coverUrl: null, writers: [], artists: [], characters: [], genres: [], storyArcs: [],
    isRead: false, readProgress: 0, isUnmatched,
});
const reply = (downloaded: ReturnType<typeof issue>[]) => ({
    id: 's1', seriesName: 'Saga', coverUrl: null, cvId: 4242, metadataId: '4242', metadataSource: 'COMICVINE', path: FOLDER,
    publisher: 'Image', year: 2012, matchState: 'MATCHED',
    downloadedIssues: downloaded,
    missingIssues: [issue('m3', '3', null, false)],
    specials: [], missingSpecials: [], collectedEditions: [], missingCollectedEditions: [], duplicates: [], coveredIssues: [],
});

const renderPage = async (downloaded: ReturnType<typeof issue>[]) => {
    stubFetchRouter([
        ['/api/library/series?', () => ok(reply(downloaded))],
        ['/api/admin/config', () => ok({ settings: [] })],
        ['/api/reviews', () => ok([])],
    ]);
    await act(async () => { render(<SeriesPage />); });
    await act(async () => { await new Promise(r => setTimeout(r, 25)); });
};

describe('Series page: Unrecognized Files Detected', () => {
    beforeEach(() => { viewer.role = 'ADMIN'; localStorage.clear(); });

    it('lists an unmatched file for an admin, with a Link to one of the missing issues', async () => {
        await renderPage([issue('d1', '1', `${FOLDER}/Saga #001.cbz`, false), issue('u2', '2', `${FOLDER}/saga scan 2.cbz`, true)]);

        expect(screen.getByText('Unrecognized Files Detected (1)')).toBeInTheDocument();
        expect(screen.getByText('saga scan 2.cbz')).toBeInTheDocument();
        expect(screen.queryByText('Saga #001.cbz')).not.toBeInTheDocument();
        // Link waits for a pick from the series' missing issues.
        expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
    });

    it('shows nothing when every file is matched', async () => {
        await renderPage([issue('d1', '1', `${FOLDER}/Saga #001.cbz`, false)]);
        expect(screen.queryByText(/Unrecognized Files Detected/)).not.toBeInTheDocument();
    });

    it("isn't shown to a regular user", async () => {
        viewer.role = 'USER';
        await renderPage([issue('u2', '2', `${FOLDER}/saga scan 2.cbz`, true)]);
        expect(screen.queryByText(/Unrecognized Files Detected/)).not.toBeInTheDocument();
    });
});
