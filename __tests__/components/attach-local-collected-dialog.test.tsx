// @vitest-environment jsdom
// The Smart Matcher's door for a trade ComicVine has no volume for (field report by
// robotshavehearts2): pick the series it collects, name it, and it goes under that series as a
// LOCAL collected edition — its files move in under their own names, no provider lane.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

import { AttachLocalCollectedDialog, localNameFromItem } from '@/components/attach-local-collected-dialog';

(global as any).ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
(window as any).PointerEvent = class PointerEvent extends Event {} as any;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const item = { id: 'u1', name: 'Saga Compendium One (2019)', folderPath: '/unmatched/Saga Compendium One (2019)', isRawFile: false };

describe('localNameFromItem', () => {
    it('offers the folder or file name without its extension or trailing year', () => {
        expect(localNameFromItem({ name: 'Saga Compendium One (2019)' })).toBe('Saga Compendium One');
        expect(localNameFromItem({ name: 'Saga Compendium One.cbz', isRawFile: true })).toBe('Saga Compendium One');
        expect(localNameFromItem({ name: '  ' })).toBe('');
    });
});

describe('AttachLocalCollectedDialog', () => {
    let posts: any[];
    beforeEach(() => {
        vi.clearAllMocks();
        posts = [];
        stubFetchRouter([
            ['/api/library?', () => ok({ series: [{ id: 's1', name: 'Saga', year: 2012 }, { id: 's2', name: 'Saga: Compendium', year: 2019 }] })],
            ['/api/library/series/attachments', (_u: string, init?: any) => { posts.push(JSON.parse(init.body)); return ok({ success: true, local: true, attachmentId: 'attL', name: 'Saga Compendium One', moved: 1, absorbed: 1, claimed: 0, conflicts: 0 }); }],
        ]);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('names the edition from the item, finds the series, and files the local attachment with the source path', async () => {
        const onDone = vi.fn();
        render(<AttachLocalCollectedDialog open item={item} onClose={vi.fn()} onDone={onDone} />);

        expect((screen.getByLabelText('Name of the collected edition') as HTMLInputElement).value).toBe('Saga Compendium One');
        // Nothing can be sent until a series is picked.
        expect((screen.getByRole('button', { name: 'Attach as a collected edition' }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.change(screen.getByLabelText('Search your library for the series it collects'), { target: { value: 'Saga' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Saga (2012)' }));
        fireEvent.click(screen.getByRole('button', { name: 'Attach as a collected edition' }));

        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0]).toEqual({
            seriesId: 's1', metadataSource: 'LOCAL', kind: 'COLLECTED', name: 'Saga Compendium One',
            sourcePath: '/unmatched/Saga Compendium One (2019)',
        });
        await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'attL', moved: 1 })));
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Attached Saga Compendium One' }));
    });

    it('refuses a blank name', async () => {
        render(<AttachLocalCollectedDialog open item={item} onClose={vi.fn()} onDone={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Search your library for the series it collects'), { target: { value: 'Saga' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Saga (2012)' }));
        fireEvent.change(screen.getByLabelText('Name of the collected edition'), { target: { value: '   ' } });
        expect((screen.getByRole('button', { name: 'Attach as a collected edition' }) as HTMLButtonElement).disabled).toBe(true);
    });
});

// #257: opened on a loose FILE, the dialog takes the edition's other books along — numbered from
// their filenames, with coverage typed or filled evenly — under a series from the library or the provider.
describe('AttachLocalCollectedDialog — picked loose books', () => {
    const raw = (n: number | string, title = 'Power Rangers Prime', ext = 'cbz') => {
        const fileName = typeof n === 'number' ? `${title} v0${n} (2025) (Digital) (dekabro-Empire).${ext}` : `${n}.${ext}`;
        return { id: `raw_${fileName}`, name: fileName.replace(/\.[^.]+$/, ''), folderPath: `/unmatched/${fileName}`, isRawFile: true };
    };
    const v1 = raw(1);
    const candidates = [v1, raw(2), raw(3, 'Power Rangers Prime', 'cbr'), raw(4), raw('Marvel Divas (2010) (digital) (Marika-Empire)')];
    let posts: any[];
    let searches: string[];

    beforeEach(() => {
        vi.clearAllMocks();
        posts = [];
        searches = [];
        stubFetchRouter([
            ['/api/library?', () => ok({ series: [{ id: 'prp', name: 'Power Rangers Prime', year: 2024 }] })],
            ['/api/search?', (u: string) => {
                searches.push(u);
                return ok({ results: [
                    { id: 161049, name: 'Power Rangers Prime', year: '2024', publisher: 'Boom! Studios', count: 16, metadataSource: 'COMICVINE' },
                    { id: 27939, name: 'Mighty Morphin Power Rangers', year: '1995', publisher: 'Hamilton Comics', count: 4, metadataSource: 'COMICVINE' },
                ] });
            }],
            ['/api/library/series/attachments', (_u: string, init?: any) => {
                posts.push(JSON.parse(init.body));
                return ok({ success: true, local: true, attachmentId: 'attL', name: 'Power Rangers Prime TPB', moved: 4, conflicts: 0, series: { id: 'prp', name: 'Power Rangers Prime', created: true } });
            }],
        ]);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const attachButton = () => screen.getByRole('button', { name: 'Attach as a collected edition' }) as HTMLButtonElement;
    const checkbox = (file: string) => screen.getByLabelText(`Include ${file}`) as HTMLInputElement;

    it('ticks the books with the same title, numbers them from their filenames, and takes the type the title says', () => {
        render(<AttachLocalCollectedDialog open item={v1} candidates={candidates} onClose={vi.fn()} onDone={vi.fn()} />);

        expect((screen.getByLabelText('Edition type') as HTMLSelectElement).value).toBe('TPB');
        // The name is "{Series} {Type}" — no free-text field unless asked for.
        expect(screen.queryByLabelText('Name of the collected edition')).toBeNull();
        for (const n of [1, 2, 4]) expect(checkbox(`Power Rangers Prime v0${n} (2025) (Digital) (dekabro-Empire).cbz`).checked).toBe(true);
        expect(checkbox('Power Rangers Prime v03 (2025) (Digital) (dekabro-Empire).cbr').checked).toBe(true);
        expect(checkbox('Marvel Divas (2010) (digital) (Marika-Empire).cbz').checked).toBe(false);
        expect((screen.getByLabelText('Volume number for Power Rangers Prime v03 (2025) (Digital) (dekabro-Empire).cbr') as HTMLInputElement).value).toBe('3');
        expect(screen.getByText('Books (4 ticked)')).toBeTruthy();
    });

    it('picks the series from the provider, fills coverage evenly, insists on a distinct edition name, and sends the books', async () => {
        const onDone = vi.fn();
        render(<AttachLocalCollectedDialog open item={v1} candidates={candidates} onClose={vi.fn()} onDone={onDone} />);

        fireEvent.click(screen.getByRole('button', { name: 'ComicVine' }));
        // The search is prefilled with the series' title and runs only when asked (it costs the rate limit).
        expect((screen.getByLabelText('Search ComicVine for the series it collects') as HTMLInputElement).value).toBe('Power Rangers Prime');
        expect(searches).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: /^Power Rangers Prime \(2024\)/ }));
        expect(searches[0]).toContain('provider=COMICVINE');

        // 16 issues over books up to Vol. 4: four per book.
        expect((screen.getByLabelText('Issues per book') as HTMLInputElement).value).toBe('4');
        fireEvent.click(screen.getByRole('button', { name: 'Fill Covers' }));
        expect((screen.getByLabelText('Covers for Power Rangers Prime v04 (2025) (Digital) (dekabro-Empire).cbz') as HTMLInputElement).value).toBe('13-16');

        // The edition is "{Series} {Type}" — its own shelf beside the run, never the series' own name.
        expect(screen.getByTestId('edition-name').textContent).toBe('Power Rangers Prime TPB');
        expect(screen.getByTestId('collected-shelf-title').textContent).toBe('TPB');
        expect(screen.getByTestId('collected-format').textContent).toBe('TPB');
        fireEvent.change(screen.getByLabelText('Edition type'), { target: { value: 'Omnibus' } });
        expect(screen.getByTestId('edition-name').textContent).toBe('Power Rangers Prime Omnibus');
        expect(screen.getByTestId('collected-shelf-title').textContent).toBe('Omnibus');
        fireEvent.change(screen.getByLabelText('Edition type'), { target: { value: 'TPB' } });
        expect(attachButton().disabled).toBe(false);

        fireEvent.click(attachButton());
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0]).toEqual({
            parent: { metadataSource: 'COMICVINE', metadataId: '161049', name: 'Power Rangers Prime', year: 2024, publisher: 'Boom! Studios' },
            metadataSource: 'LOCAL', kind: 'COLLECTED', name: 'Power Rangers Prime TPB', coverFromBook: true,
            files: [
                { path: '/unmatched/Power Rangers Prime v01 (2025) (Digital) (dekabro-Empire).cbz', number: '1', coversIssues: '1-4' },
                { path: '/unmatched/Power Rangers Prime v02 (2025) (Digital) (dekabro-Empire).cbz', number: '2', coversIssues: '5-8' },
                { path: '/unmatched/Power Rangers Prime v03 (2025) (Digital) (dekabro-Empire).cbr', number: '3', coversIssues: '9-12' },
                { path: '/unmatched/Power Rangers Prime v04 (2025) (Digital) (dekabro-Empire).cbz', number: '4', coversIssues: '13-16' },
            ],
        });
        await waitFor(() => expect(onDone).toHaveBeenCalled());
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('added to your library') }));
    });

    it('attaches to a library series, leaves out an unticked book, and stops on two books with one number', async () => {
        render(<AttachLocalCollectedDialog open item={v1} candidates={candidates} onClose={vi.fn()} onDone={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Search your library for the series it collects'), { target: { value: 'Power' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Power Rangers Prime (2024)' }));
        // A custom name may not be the series' own…
        fireEvent.click(screen.getByLabelText('Custom edition name'));
        fireEvent.change(screen.getByLabelText('Name of the collected edition'), { target: { value: 'Power Rangers Prime' } });
        expect(attachButton().disabled).toBe(true);
        expect(screen.getByRole('button', { name: 'Use "Power Rangers Prime TPB"' })).toBeTruthy();
        // …any other is its own shelf, typed by the name.
        fireEvent.change(screen.getByLabelText('Name of the collected edition'), { target: { value: 'Power Rangers Prime Deluxe' } });
        expect(screen.getByTestId('collected-shelf-title').textContent).toBe('Deluxe');
        expect(screen.getByTestId('collected-format').textContent).toBe('HC');

        fireEvent.change(screen.getByLabelText('Volume number for Power Rangers Prime v02 (2025) (Digital) (dekabro-Empire).cbz'), { target: { value: '1' } });
        expect(attachButton().disabled).toBe(true);
        expect(screen.getByText('Two books are both Vol. 1.')).toBeTruthy();

        fireEvent.click(checkbox('Power Rangers Prime v02 (2025) (Digital) (dekabro-Empire).cbz'));
        fireEvent.click(checkbox('Power Rangers Prime v03 (2025) (Digital) (dekabro-Empire).cbr'));
        fireEvent.click(checkbox('Power Rangers Prime v04 (2025) (Digital) (dekabro-Empire).cbz'));
        expect(attachButton().disabled).toBe(false);

        fireEvent.click(attachButton());
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0]).toEqual({
            seriesId: 'prp', metadataSource: 'LOCAL', kind: 'COLLECTED', name: 'Power Rangers Prime Deluxe', coverFromBook: false,
            files: [{ path: '/unmatched/Power Rangers Prime v01 (2025) (Digital) (dekabro-Empire).cbz', number: '1', coversIssues: '' }],
        });
    });
});

describe('AttachLocalCollectedDialog — the edition type', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const raw = (fileName: string) => ({ id: `raw_${fileName}`, name: fileName.replace(/\.[^.]+$/, ''), folderPath: `/unmatched/${fileName}`, isRawFile: true });

    it.each([
        ['Captain America Omnibus v01 (2024, 3rd edition) (digital) (TONER).cbz', 'Omnibus'],
        ['Batman - The Dark Knight Returns - Deluxe Edition (2026) (digital).cbr', 'HC'],
        ['Power Rangers Prime v01 (2025) (Digital).cbz', 'TPB'],
    ])('%s starts as %s', (fileName, kind) => {
        stubFetchRouter([]);
        const item = raw(fileName);
        render(<AttachLocalCollectedDialog open item={item} candidates={[item]} onClose={vi.fn()} onDone={vi.fn()} />);
        expect((screen.getByLabelText('Edition type') as HTMLSelectElement).value).toBe(kind);
    });

    it('names an omnibus after its series, and a custom name is typed by what it adds', async () => {
        stubFetchRouter([['/api/library?', () => ok({ series: [{ id: 'cap', name: 'Captain America', year: 1968 }] })]]);
        const item = raw('Captain America Omnibus v01 (2024, 3rd edition) (digital) (TONER).cbz');
        render(<AttachLocalCollectedDialog open item={item} candidates={[item]} onClose={vi.fn()} onDone={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Search your library for the series it collects'), { target: { value: 'Captain' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Captain America (1968)' }));
        expect(screen.getByTestId('edition-name').textContent).toBe('Captain America Omnibus');
        expect(screen.getByTestId('collected-shelf-title').textContent).toBe('Omnibus');

        fireEvent.click(screen.getByLabelText('Custom edition name'));
        // The type select steps aside: a custom name says its own type.
        expect((screen.getByLabelText('Edition type') as HTMLSelectElement).disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('Name of the collected edition'), { target: { value: 'Captain America Epic Collection' } });
        expect(screen.getByTestId('collected-shelf-title').textContent).toBe('Epic Collection');
        expect(screen.getByTestId('collected-format').textContent).toBe('TPB');
    });
});

describe('AttachLocalCollectedDialog — series cover from the first book', () => {
    const v1 = { id: 'raw_v1', name: 'Power Rangers Prime v01 (2025) (Digital)', folderPath: '/unmatched/Power Rangers Prime v01 (2025) (Digital).cbz', isRawFile: true };
    const v2 = { id: 'raw_v2', name: 'Power Rangers Prime v02 (2025) (Digital)', folderPath: '/unmatched/Power Rangers Prime v02 (2025) (Digital).cbz', isRawFile: true };
    let posts: any[];
    let seriesCover: string | null;

    beforeEach(() => {
        vi.clearAllMocks();
        posts = [];
        seriesCover = 'book';
        stubFetchRouter([
            ['/api/library?', () => ok({ series: [{ id: 'prp', name: 'Power Rangers Prime', year: 2024 }] })],
            ['/api/search?', () => ok({ results: [{ id: 161049, name: 'Power Rangers Prime', year: '2024', publisher: 'BOOM! Studios', count: 16, metadataSource: 'COMICVINE' }] })],
            ['/api/library/series/attachments', (_u: string, init?: any) => {
                posts.push(JSON.parse(init.body));
                return ok({ success: true, local: true, attachmentId: 'attL', name: 'Power Rangers Prime TPB', moved: 2, conflicts: 0, failed: 0, seriesCover,
                    series: { id: 'prp', name: 'Power Rangers Prime', folderPath: '/comics/BOOM! Studios/Power Rangers Prime (2024)', created: true } });
            }],
        ]);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const coverBox = () => screen.getByLabelText("Use the first book's own cover as the series cover") as HTMLInputElement;

    it('is on for a series picked from the provider, and asks the server to do it (before the sync it queues)', async () => {
        render(<AttachLocalCollectedDialog open item={v1} candidates={[v1, v2]} onClose={vi.fn()} onDone={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'ComicVine' }));
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        fireEvent.click(await screen.findByRole('button', { name: /^Power Rangers Prime \(2024\)/ }));
        expect(coverBox().checked).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Attach as a collected edition' }));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].coverFromBook).toBe(true);
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("Its cover is now the first book's own.") })));
    });

    it("is off for a library series, and says so when the server couldn't read the book's first page", async () => {
        seriesCover = 'failed';
        render(<AttachLocalCollectedDialog open item={v1} candidates={[v1, v2]} onClose={vi.fn()} onDone={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Search your library for the series it collects'), { target: { value: 'Power' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Power Rangers Prime (2024)' }));
        expect(coverBox().checked).toBe(false);

        fireEvent.click(coverBox());
        fireEvent.click(screen.getByRole('button', { name: 'Attach as a collected edition' }));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].coverFromBook).toBe(true);
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "The books are attached, but the series cover didn't change" })));
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Attached Power Rangers Prime TPB' }));
    });
});

describe('AttachLocalCollectedDialog — the type follows the picked series', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const ab = { id: 'raw_ab', name: 'Absolute Batman v01 (2025) (Digital)', folderPath: '/unmatched/Absolute Batman v01 (2025) (Digital).cbz', isRawFile: true };
    const pick = async () => {
        fireEvent.change(screen.getByLabelText('Search your library for the series it collects'), { target: { value: 'Absolute' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Absolute Batman (2024)' }));
    };

    it('reads "Absolute" as part of the series once the series is known', async () => {
        stubFetchRouter([['/api/library?', () => ok({ series: [{ id: 'ab', name: 'Absolute Batman', year: 2024 }] })]]);
        render(<AttachLocalCollectedDialog open item={ab} candidates={[ab]} onClose={vi.fn()} onDone={vi.fn()} />);
        // Without a series, "Absolute" reads as an Absolute (hardcover) edition…
        expect((screen.getByLabelText('Edition type') as HTMLSelectElement).value).toBe('HC');
        await pick();
        // …with Absolute Batman picked, it's the series' own name: a TPB.
        expect((screen.getByLabelText('Edition type') as HTMLSelectElement).value).toBe('TPB');
        expect(screen.getByTestId('edition-name').textContent).toBe('Absolute Batman TPB');
    });

    it('keeps a type the admin picked by hand', async () => {
        stubFetchRouter([['/api/library?', () => ok({ series: [{ id: 'ab', name: 'Absolute Batman', year: 2024 }] })]]);
        render(<AttachLocalCollectedDialog open item={ab} candidates={[ab]} onClose={vi.fn()} onDone={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Edition type'), { target: { value: 'Omnibus' } });
        await pick();
        expect((screen.getByLabelText('Edition type') as HTMLSelectElement).value).toBe('Omnibus');
    });
});
