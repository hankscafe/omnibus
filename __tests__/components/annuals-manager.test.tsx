// @vitest-environment jsdom
// #203 Phase 1 Beta B: the Annuals panel. What's pinned here is the honesty of the surface — the
// attach reports what the pass actually did (including what it did NOT claim), the search is
// pre-seeded the way a user would type it, and detach never reaches a file unless asked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnnualsManager, summaryLine } from '@/components/annuals-manager';
import { ok, stubFetchRouter } from '../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
// next/image needs no optimizer in jsdom.
vi.mock('next/image', () => ({ default: (props: any) => <img alt={props.alt ?? ''} src={props.src} /> }));

const attachment = {
    id: 'att1', metadataSource: 'COMICVINE', volumeId: '49197', kind: 'ANNUAL',
    name: 'Batman Annual', startYear: 2012, issueCount: 4, ownedCount: 2, lastSyncedAt: null,
};

const baseProps = { seriesId: 's1', seriesName: 'Batman', defaultProvider: 'COMICVINE' };

describe('summaryLine (#203 Beta B)', () => {
    it('says what happened, including what was left alone', () => {
        expect(summaryLine({ total: 4, claimed: 2, created: 2, updated: 0, unclaimed: 1 }))
            .toBe('4 issues in this volume — claimed 2 files you already own · added 2 missing entries. 1 annual file here still belongs to no volume.');
        // Singulars read like English, and a no-op pass admits it.
        expect(summaryLine({ total: 1, claimed: 1, created: 0, updated: 0, unclaimed: 0 }))
            .toBe('1 issue in this volume — claimed 1 file you already own.');
        expect(summaryLine({ total: 4, claimed: 0, created: 0, updated: 0, unclaimed: 0 }))
            .toBe('4 issues in this volume — nothing changed.');
    });
});

describe('AnnualsManager', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('lists an attachment with how much of it is actually owned', async () => {
        stubFetchRouter([['/api/library/series/attachments', () => ok({ attachments: [attachment] })]]);

        render(<AnnualsManager {...baseProps} />);

        expect(await screen.findByText('Batman Annual')).toBeTruthy();
        expect(screen.getByText(/COMICVINE 49197 · 2 of 4 owned/)).toBeTruthy();
        // The renumbering promise is stated where the user would worry about it.
        expect(screen.getByText(/matched by ID, never by number/)).toBeTruthy();
    });

    it('stays quiet on a series with no annuals, and speaks up when files are unattached', async () => {
        stubFetchRouter([['/api/library/series/attachments', () => ok({ attachments: [] })]]);

        const { rerender } = render(<AnnualsManager {...baseProps} />);
        await waitFor(() => expect(screen.getByText('Annuals')).toBeTruthy());
        expect(screen.queryByText(/belongs? to\s+no volume yet/)).toBeNull();

        rerender(<AnnualsManager {...baseProps} unattachedAnnuals={3} />);
        expect(await screen.findByText(/3 annual files here belong to\s+no volume yet/)).toBeTruthy();
    });

    it('pre-seeds the search with "<series> annual" and attaches the picked volume', async () => {
        const fetchMock = stubFetchRouter([
            [/\/api\/library\/series\/attachments\?/, () => ok({ attachments: [] })],
            ['/api/search', () => ok({ results: [{ id: 49197, name: 'Batman Annual', year: 2012, publisher: 'DC Comics' }] })],
            ['/api/library/series/attachments', () => ok({
                success: true, attachmentId: 'att1', name: 'Batman Annual',
                summary: { total: 4, claimed: 2, created: 2, updated: 0, unclaimed: 1 },
            })],
        ]);
        const onChanged = vi.fn();

        render(<AnnualsManager {...baseProps} onChanged={onChanged} />);
        fireEvent.click(await screen.findByText('Attach annual volume'));

        const input = await screen.findByPlaceholderText('Search the provider for the annual volume');
        expect((input as HTMLInputElement).value).toBe('Batman annual');

        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Attach Batman Annual' }));

        await waitFor(() => {
            const post = fetchMock.mock.calls.find(c => c[1]?.method === 'POST');
            expect(JSON.parse(post![1].body)).toMatchObject({
                seriesId: 's1', volumeId: '49197', metadataSource: 'COMICVINE', kind: 'ANNUAL',
            });
        });
        // The result line is the whole point of the silent claim.
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Attached Batman Annual',
            description: expect.stringContaining('claimed 2 files you already own'),
        })));
        expect(onChanged).toHaveBeenCalled();
    });

    it('detaches without deleting anything unless the sweep is ticked', async () => {
        const fetchMock = stubFetchRouter([
            [/\/api\/library\/series\/attachments\?/, () => ok({ attachments: [attachment] })],
            ['/api/library/series/attachments', () => ok({ success: true, keptIssues: 3, skeletonsDeleted: 0 })],
        ]);

        render(<AnnualsManager {...baseProps} />);
        fireEvent.click(await screen.findByText('Detach'));

        // Default is the non-destructive one: unlink only.
        const confirm = await screen.findByRole('button', { name: /^Detach$/ });
        fireEvent.click(confirm);

        await waitFor(() => {
            const del = fetchMock.mock.calls.find(c => c[1]?.method === 'DELETE');
            expect(JSON.parse(del![1].body)).toEqual({ attachmentId: 'att1', deleteSkeletons: false });
        });
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            description: expect.stringContaining('Your files were not touched.'),
        })));
    });
});
