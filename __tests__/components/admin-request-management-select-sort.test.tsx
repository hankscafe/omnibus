// @vitest-environment jsdom
// #265: below tablet width Request Management shows cards, and the table's header row - the only place
// with Select all and sorting - isn't on screen, so a phone could neither select a page nor sort it. The
// cards get a bar with both, sharing the table's order.
// And Select all only knew the size of the page it was on: after a full page 1, page 2's box showed as
// ticked (one click cleared everything), and on a shorter page it replaced the selection instead of
// adding to it. It now adds the page on screen to the selection, or takes it out.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/interactive-search-modal', () => ({ InteractiveSearchModal: () => null }));

// Radix Select calls these, and jsdom has neither.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

import { AdminRequestManagement } from '@/components/admin-request-management';

const row = (id: string, status: string, name: string, userName: string, createdAt: string, updatedAt: string) => ({
    id, status, activeDownloadName: name, seriesName: name, userName, volumeId: '101', metadataSource: 'COMICVINE',
    createdAt, updatedAt, retryCount: 0,
});

// Every column orders these four differently.
const FOUR = [
    row('r1', 'COMPLETED', 'Batman #1', 'zoe', '2026-10-21T12:00:00.000Z', '2026-10-30T12:00:00.000Z'),
    row('r2', 'NOT_FOUND', 'Saga #61', 'amy', '2026-10-24T12:00:00.000Z', '2026-10-25T12:00:00.000Z'),
    row('r3', 'STALLED', 'X-Men #5', 'max', '2026-10-22T12:00:00.000Z', '2026-10-28T12:00:00.000Z'),
    row('r4', 'PENDING', 'Aquaman #2', 'bob', '2026-10-23T12:00:00.000Z', '2026-10-26T12:00:00.000Z'),
];

// `n` pending requests; the page size is 24.
const many = (n: number) => Array.from({ length: n }, (_, i) => row(
    `p${i}`, 'PENDING', `Series ${String(i).padStart(2, '0')} #1`, 'reader',
    new Date(Date.UTC(2026, 9, 1, i)).toISOString(), '2026-10-30T12:00:00.000Z',
));

let requests: ReturnType<typeof row>[] = [];
beforeEach(() => {
    requests = FOUR;
    stubFetchRouter([['/api/admin/requests', () => ok(requests)]]);
});

const renderList = async () => { await act(async () => { render(<AdminRequestManagement />); }); };

// jsdom applies no CSS, so the table and the cards are both in the document.
const cards = () => screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent);
const tableNames = () => within(screen.getByRole('table')).getAllByRole('row').slice(1)
    .map(r => r.querySelectorAll('td')[1]?.textContent);
const headerBox = () => within(screen.getByRole('table')).getAllByRole('checkbox')[0];
const phoneBox = () => screen.getByRole('checkbox', { name: 'Select all' });
const sortMenu = () => screen.getByRole('combobox', { name: 'Sort by' });
const reverse = () => screen.getByRole('button', { name: /^Sorted (ascending|descending)$/ });
const arrow = () => reverse().querySelector('svg')?.getAttribute('class') ?? '';
const deleteButton = () => screen.queryByRole('button', { name: /^delete \(\d+\)$/i });
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };

// Radix opens a Select from the keyboard in jsdom.
const pickSort = async (label: string) => {
    await act(async () => { fireEvent.keyDown(sortMenu(), { key: 'ArrowDown' }); });
    await click(screen.getByRole('option', { name: label }));
};
// The pager's buttons: first, previous, next, last.
const nextPage = async () => {
    await click(within(screen.getByText(/^Pg \d+ of \d+$/).parentElement as HTMLElement).getAllByRole('button')[2]);
};

describe('Request Management on a phone: Select all (#265)', () => {
    it('the cards have a Select all box: it selects the page, and clears it again', async () => {
        await renderList();

        await click(phoneBox());
        expect(deleteButton()?.textContent).toMatch(/delete \(4\)/i);
        expect(phoneBox().getAttribute('aria-checked')).toBe('true');

        await click(phoneBox());
        expect(deleteButton()).toBeNull();
        expect(phoneBox().getAttribute('aria-checked')).toBe('false');
    });

    it('one ticked request leaves the box unticked, and the box then adds the rest', async () => {
        await renderList();

        await click(within(screen.getByRole('table')).getAllByRole('checkbox')[1]);
        expect(phoneBox().getAttribute('aria-checked')).toBe('false');
        expect(headerBox().getAttribute('aria-checked')).toBe('false');

        await click(phoneBox());
        expect(deleteButton()?.textContent).toMatch(/delete \(4\)/i);
    });

    it('ticking it ticks the table header too: one selection, two layouts', async () => {
        await renderList();

        await click(phoneBox());
        expect(headerBox().getAttribute('aria-checked')).toBe('true');
    });

    it('an empty list has nothing ticked, and no bar on the cards', async () => {
        await renderList();

        await act(async () => { fireEvent.change(screen.getByPlaceholderText(/search by series/i), { target: { value: 'no such series' } }); });
        expect(headerBox().getAttribute('aria-checked')).toBe('false');
        expect(screen.queryByRole('checkbox', { name: 'Select all' })).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull();
    });
});

describe('Request Management on a phone: Sort (#265)', () => {
    it('the cards start newest request first, like the table', async () => {
        await renderList();

        expect(cards()).toEqual(['Saga #61', 'Aquaman #2', 'X-Men #5', 'Batman #1']);
        expect(sortMenu().textContent).toContain('Requested');
        expect(reverse().getAttribute('aria-label')).toBe('Sorted descending');
        expect(arrow()).toContain('lucide-arrow-down-wide-narrow');
    });

    it.each([
        ['Series', ['Aquaman #2', 'Batman #1', 'Saga #61', 'X-Men #5']],
        ['User', ['Saga #61', 'Aquaman #2', 'X-Men #5', 'Batman #1']],
        ['Status', ['Batman #1', 'Saga #61', 'Aquaman #2', 'X-Men #5']],
        ['Completed', ['Saga #61', 'Aquaman #2', 'X-Men #5', 'Batman #1']],
    ])('sorts by %s, and the arrow reverses it', async (label, ascending) => {
        await renderList();

        await pickSort(label);
        expect(cards()).toEqual(ascending);
        expect(reverse().getAttribute('aria-label')).toBe('Sorted ascending');
        expect(arrow()).toContain('lucide-arrow-up-narrow-wide');

        await click(reverse());
        expect(cards()).toEqual([...ascending].reverse());
        expect(reverse().getAttribute('aria-label')).toBe('Sorted descending');
    });

    it('picking Requested again sorts oldest first, as the table does for a new column', async () => {
        await renderList();

        await pickSort('Series');
        await pickSort('Requested');
        expect(cards()).toEqual(['Batman #1', 'X-Men #5', 'Aquaman #2', 'Saga #61']);
    });

    it('shares its order with the table: the menu follows a header click, and the table follows the menu', async () => {
        await renderList();

        await click(screen.getByText('Series / Name'));
        expect(sortMenu().textContent).toContain('Series');
        expect(cards()).toEqual(['Aquaman #2', 'Batman #1', 'Saga #61', 'X-Men #5']);

        await pickSort('User');
        expect(tableNames()).toEqual(['Saga #61', 'Aquaman #2', 'X-Men #5', 'Batman #1']);
    });
});

describe('Request Management: Select all covers the page on screen (#265)', () => {
    it("a full page 1 doesn't tick page 2's box, and ticking it adds page 2 instead of clearing", async () => {
        requests = many(48);
        await renderList();

        await click(headerBox());
        expect(deleteButton()?.textContent).toMatch(/delete \(24\)/i);

        await nextPage();
        expect(headerBox().getAttribute('aria-checked')).toBe('false');
        expect(phoneBox().getAttribute('aria-checked')).toBe('false');

        await click(headerBox());
        expect(deleteButton()?.textContent).toMatch(/delete \(48\)/i);

        // Unticking takes out this page only.
        await click(headerBox());
        expect(deleteButton()?.textContent).toMatch(/delete \(24\)/i);
    });

    it("a shorter last page adds to the selection instead of replacing it", async () => {
        requests = many(30);
        await renderList();

        await click(phoneBox());
        await nextPage();
        await click(phoneBox());
        expect(deleteButton()?.textContent).toMatch(/delete \(30\)/i);
    });
});
