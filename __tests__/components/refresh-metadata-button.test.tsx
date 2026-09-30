// @vitest-environment jsdom
// __tests__/components/refresh-metadata-button.test.tsx
//
// Metron beta 4 (#216 follow-up): with the "per-issue credits" setting off, a series' Refresh Metadata
// no longer fetches per-issue Metron credits on its own. When issues on disk are missing them, it asks
// first - with the count, since each one costs a Metron request - and the refresh carries the answer.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err, stubFetchRouter } from '../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

import { RefreshMetadataButton } from '@/components/refresh-metadata-button';

let posts: any[] = [];
const serve = (preflight: () => any) => stubFetchRouter([
    ['/api/library/refresh-metadata', (_u, init) => {
        if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return ok({ success: true }); }
        return preflight();
    }],
]);
const click = () => fireEvent.click(screen.getByRole('button', { name: /Refresh Metadata/ }));
const BASE = { metadataId: '4000', metadataSource: 'METRON', folderPath: '/lib/Saga' };

describe('RefreshMetadataButton', () => {
    beforeEach(() => { posts = []; toast.mockClear(); });
    afterEach(() => vi.unstubAllGlobals());

    it('refreshes straight away when nothing is missing', async () => {
        serve(() => ok({ creditsEnabled: false, missingCredits: 0 }));
        render(<RefreshMetadataButton {...BASE} />);

        click();

        await waitFor(() => expect(posts).toEqual([BASE]));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('does not ask while the setting is on - every sync fetches them anyway', async () => {
        serve(() => ok({ creditsEnabled: true, missingCredits: 340 }));
        render(<RefreshMetadataButton {...BASE} />);

        click();

        await waitFor(() => expect(posts).toEqual([BASE]));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('asks with the count, and a yes sends fetchCredits', async () => {
        serve(() => ok({ creditsEnabled: false, missingCredits: 340 }));
        render(<RefreshMetadataButton {...BASE} />);

        click();

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('340 issues');
        expect(dialog).toHaveTextContent('about 340 Metron requests');
        expect(posts).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: /Refresh \+ fetch credits/ }));
        await waitFor(() => expect(posts).toEqual([{ ...BASE, fetchCredits: true }]));
    });

    it('"Refresh only" refreshes without them', async () => {
        serve(() => ok({ creditsEnabled: false, missingCredits: 1 }));
        render(<RefreshMetadataButton {...BASE} />);

        click();
        expect(await screen.findByRole('dialog')).toHaveTextContent('1 issue ');
        fireEvent.click(screen.getByRole('button', { name: /Refresh only/ }));

        await waitFor(() => expect(posts).toEqual([BASE]));
    });

    it('Cancel refreshes nothing', async () => {
        serve(() => ok({ creditsEnabled: false, missingCredits: 12 }));
        render(<RefreshMetadataButton {...BASE} />);

        click();
        await screen.findByRole('dialog');
        fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(posts).toEqual([]);
    });

    it('when the count can\'t be read, it refreshes without asking (and without credits)', async () => {
        serve(() => err(500));
        render(<RefreshMetadataButton {...BASE} />);

        click();

        await waitFor(() => expect(posts).toEqual([BASE]));
    });
});
