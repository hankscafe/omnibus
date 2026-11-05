// @vitest-environment jsdom
// Request Management's Release Date column (between Requested and Completed): the day an UNRELEASED
// request's issue comes out, when its series knows it. The API sends it only for UNRELEASED requests;
// every other row shows a dash, and sorting by it puts those last whichever way.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/interactive-search-modal', () => ({ InteractiveSearchModal: () => null }));

// Radix Select calls these, and jsdom has neither.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

import { AdminRequestManagement } from '@/components/admin-request-management';

const row = (id: string, status: string, name: string, releaseDate: string | null, createdAt: string) => ({
    id, status, activeDownloadName: name, seriesName: name, userName: 'reader', volumeId: '101', metadataSource: 'COMICVINE',
    createdAt, updatedAt: createdAt, releaseDate, retryCount: 0,
});

const SAGA = row('r1', 'UNRELEASED', 'Saga #70', '2026-12-02', '2026-10-24T12:00:00.000Z');
const BATMAN = row('r2', 'UNRELEASED', 'Batman #160', '2026-11-18', '2026-10-23T12:00:00.000Z');
const XMEN = row('r3', 'NOT_FOUND', 'X-Men #5', null, '2026-10-22T12:00:00.000Z');
const SPAWN = row('r4', 'UNRELEASED', 'Spawn #400', null, '2026-10-21T12:00:00.000Z');

let requests: ReturnType<typeof row>[] = [];
beforeEach(() => {
    // Undated rows first: a sort that leaves them where they came would keep them on top.
    requests = [XMEN, SAGA, SPAWN, BATMAN];
    stubFetchRouter([['/api/admin/requests', () => ok(requests)]]);
});

const renderList = async () => { await act(async () => { render(<AdminRequestManagement />); }); };
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };

// jsdom applies no CSS, so the table and the cards are both in the document.
const table = () => screen.getByRole('table');
const tableRow = (name: string) => within(table()).getByTitle(name).closest('tr') as HTMLElement;
const tableNames = () => within(table()).getAllByRole('row').slice(1).map(r => r.querySelectorAll('td')[1]?.textContent);
const cards = () => screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent);
// The day itself, whatever the time zone: built from local parts, as an admin reads it.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString();

describe('Request Management: Release Date', () => {
    it('is a column between Requested and Completed, showing the day an UNRELEASED issue comes out', async () => {
        await renderList();

        const headers = within(table()).getAllByRole('columnheader').map(h => h.textContent?.trim());
        expect(headers.slice(4, 7)).toEqual(['Requested', 'Release Date', 'Completed']);

        const releaseCell = (name: string) => tableRow(name).querySelectorAll('td')[5].textContent;
        expect(releaseCell('Saga #70')).toBe(day(2026, 12, 2));
        expect(releaseCell('Batman #160')).toBe(day(2026, 11, 18));
        expect(releaseCell('X-Men #5')).toBe('-');
        expect(releaseCell('Spawn #400')).toBe('-');
    });

    it('sorts soonest first, then latest first, with undated requests last both ways', async () => {
        await renderList();
        const header = within(table()).getByText('Release Date');

        await click(header);
        expect(tableNames().slice(0, 2)).toEqual(['Batman #160', 'Saga #70']);
        expect(tableNames().slice(2).sort()).toEqual(['Spawn #400', 'X-Men #5']);

        await click(header);
        expect(tableNames().slice(0, 2)).toEqual(['Saga #70', 'Batman #160']);
        expect(tableNames().slice(2).sort()).toEqual(['Spawn #400', 'X-Men #5']);
    });

    it("shows on a phone's card only when there is a date", async () => {
        requests = [SAGA, XMEN];
        await renderList();

        const labels = screen.getAllByText('Release Date', { selector: 'span' });
        expect(labels).toHaveLength(1);
        expect(labels[0].parentElement?.textContent).toContain(day(2026, 12, 2));
    });

    it("is in the phone layout's Sort menu, sorting the cards the same way", async () => {
        await renderList();

        await act(async () => { fireEvent.keyDown(screen.getByRole('combobox', { name: 'Sort by' }), { key: 'ArrowDown' }); });
        await click(screen.getByRole('option', { name: 'Release Date' }));

        expect(cards().slice(0, 2)).toEqual(['Batman #160', 'Saga #70']);
        expect(cards().slice(2).sort()).toEqual(['Spawn #400', 'X-Men #5']);
    });
});
