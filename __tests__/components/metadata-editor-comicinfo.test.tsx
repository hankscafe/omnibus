// @vitest-environment jsdom
// #199 series-editor tabs: the post-match home of the ComicInfo defaults. These tests pin the
// load → edit → save round-trip: values seed from the series API's comicInfo bag (list columns
// joined to comma text), edits post through library/update with every field present (editor
// semantics: an emptied field is an explicit clear), and the loaded values a user never touched
// round-trip unchanged — so a description-only save can't wipe provider genres or stored defaults.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MetadataEditorModal from '@/components/metadata-editor-modal';
import { openTab } from '../helpers/radix';
import { ok } from '../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));



let captured: any = null;
const seriesPayload = {
    seriesName: 'Caravan', path: '/comics/Caravan',
    description: 'Italian publication.', universe: '', seriesGroup: '',
    hasCustomMetadata: false,
    comicInfo: {
        imprint: 'Sergio Bonelli Editore', format: null, languageISO: 'it', ageRating: null,
        communityRating: 4.5, blackAndWhite: true, gtin: null, notes: null, scanInformation: null,
        review: null, mainCharacterOrTeam: null, alternateSeries: null, alternateNumber: null,
        alternateCount: null, storyArcNumber: null,
        genres: ['Western'], writers: ['G. Writer One', 'G. Writer Two'], artists: [], coverArtists: [],
        colorists: [], letterers: [], characters: [], teams: [], locations: [], storyArcs: [],
        inker: [], editor: [], translator: [], tags: [],
    },
};

const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    mode: 'series' as const,
    series: { currentPath: '/comics/Caravan', name: 'Caravan' },
};

describe('MetadataEditorModal series mode — ComicInfo defaults (#199)', () => {
    beforeEach(() => {
        captured = null;
        vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
            if (String(url).startsWith('/api/admin/config')) return ok({ settings: [] });
            if (String(url).startsWith('/api/library/series')) return ok(seriesPayload);
            if (String(url).startsWith('/api/library/update')) {
                captured = JSON.parse(init.body);
                return ok({ success: true, newPath: '/comics/Caravan', changed: true });
            }
            return ok({});
        }));
    });

    it('seeds the tabs from the series API and shows list columns as comma text', async () => {
        render(<MetadataEditorModal {...baseProps} />);

        // General tab carries the extras once the load settles.
        await waitFor(() => expect((screen.getByLabelText('Publisher Imprint') as HTMLInputElement).value).toBe('Sergio Bonelli Editore'));
        expect((screen.getByLabelText('Language') as HTMLInputElement).value).toBe('it');

        openTab(/credits/i);
        expect((screen.getByLabelText('Writer') as HTMLInputElement).value).toBe('G. Writer One, G. Writer Two');

        openTab(/details/i);
        expect(screen.getByRole('switch', { name: /black and white/i }).getAttribute('aria-checked')).toBe('true');
        expect((screen.getByLabelText('GTIN') as HTMLInputElement).value).toBe('');
    });

    it('saves every field (untouched values round-trip, edits apply, B&W boolean always present)', async () => {
        render(<MetadataEditorModal {...baseProps} />);
        await waitFor(() => expect((screen.getByLabelText('Publisher Imprint') as HTMLInputElement).value).toBe('Sergio Bonelli Editore'));

        openTab(/story/i);
        fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'ninja, western' } });

        fireEvent.click(screen.getByRole('button', { name: /save metadata/i }));
        await waitFor(() => expect(captured).not.toBeNull());

        expect(captured.tags).toBe('ninja, western');            // the edit
        expect(captured.imprint).toBe('Sergio Bonelli Editore'); // untouched values round-trip
        expect(captured.writer).toBe('G. Writer One, G. Writer Two');
        expect(captured.genre).toBe('Western');                  // provider genres can't be wiped by a save
        expect(captured.blackAndWhite).toBe(true);
        expect(captured.lockMetadata).toBe(true);
    });

    it('an emptied field is sent as an explicit clear (editor semantics)', async () => {
        render(<MetadataEditorModal {...baseProps} />);
        await waitFor(() => expect((screen.getByLabelText('Publisher Imprint') as HTMLInputElement).value).toBe('Sergio Bonelli Editore'));

        fireEvent.change(screen.getByLabelText('Publisher Imprint'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: /save metadata/i }));
        await waitFor(() => expect(captured).not.toBeNull());

        expect(captured.imprint).toBe(''); // the route stores '' as null = cleared
    });
});

// #199 Call-3 Beta C: issue mode wears the same four tabs, rendered from the SAME shared bodies
// through the plural-key adapter. These tests pin the load -> edit -> save loop across tabs
// (field state survives Radix unmounting inactive tab content) and the tri-state B&W contract.
describe('MetadataEditorModal issue mode - tabbed per-issue editor (#199 Call-3 Beta C)', () => {
    let patched: any = null;
    const issueDetail = {
        number: '154', name: 'La Signora Dei Lupi', releaseDate: '2026-03-01', universe: '',
        description: 'Dragonero issue.', hasCustomMetadata: false,
        writers: ['Luca Enoch'], artists: ['Giuseppe Matteoni'], coverArtists: [], colorists: [], letterers: [],
        inker: ['Ink Uno'], editor: [], translator: ['Trad Uno'],
        characters: ['Ian Aranill'], teams: [], locations: [], genres: ['Fantasy'], storyArcs: [],
        tags: ['bonelli'], mainCharacterOrTeam: 'Dragonero', alternateSeries: '', alternateNumber: '19B',
        alternateCount: null, storyArcNumber: '', gtin: '9791234567897', notes: '', scanInformation: '',
        review: '', blackAndWhite: false, communityRating: 4,
    };
    const issueProps = {
        open: true,
        onOpenChange: vi.fn(),
        mode: 'issue' as const,
        issue: { id: 'i154', seriesName: 'Dragonero', number: '154' },
    };

    beforeEach(() => {
        patched = null;
        vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
            if (String(url).startsWith('/api/admin/config')) return ok({ settings: [] });
            if (String(url).startsWith('/api/library/issue') && init?.method === 'PATCH') {
                patched = JSON.parse(init.body);
                return ok({ success: true, changed: true, wroteToFile: true });
            }
            if (String(url).startsWith('/api/library/issue')) return ok(issueDetail);
            return ok({});
        }));
    });

    it('renders the four tabs and seeds every tab body from the issue API', async () => {
        render(<MetadataEditorModal {...issueProps} />);

        // General
        await waitFor(() => expect((screen.getByLabelText('Title', { selector: 'input' }) as HTMLInputElement).value).toBe('La Signora Dei Lupi'));
        expect((screen.getByLabelText('Number', { selector: 'input' }) as HTMLInputElement).value).toBe('154');

        // Credits: the shared bodies read through the plural-key adapter.
        openTab(/credits/i);
        expect((screen.getByLabelText('Writer') as HTMLInputElement).value).toBe('Luca Enoch');
        expect((screen.getByLabelText('Penciller') as HTMLInputElement).value).toBe('Giuseppe Matteoni');
        expect((screen.getByLabelText('Inker') as HTMLInputElement).value).toBe('Ink Uno');
        expect((screen.getByLabelText('Translator') as HTMLInputElement).value).toBe('Trad Uno');

        openTab(/story/i);
        expect((screen.getByLabelText('Tags') as HTMLInputElement).value).toBe('bonelli');
        expect((screen.getByLabelText('Alternate Number') as HTMLInputElement).value).toBe('19B');

        openTab(/details/i);
        expect((screen.getByLabelText('GTIN') as HTMLInputElement).value).toBe('9791234567897');
        // Tri-state control: the loaded explicit "No" is pressed — no two-way B&W switch here
        // (the write-to-file switch below the tabs is a different control and stays).
        expect(screen.queryByRole('switch', { name: /black and white/i })).toBeNull();
        expect(screen.getByRole('button', { name: 'No' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Unknown' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('saves every field across tabs - edits apply, unmounted-tab values round-trip, B&W stays an explicit No', async () => {
        render(<MetadataEditorModal {...issueProps} />);
        await waitFor(() => expect((screen.getByLabelText('Number', { selector: 'input' }) as HTMLInputElement).value).toBe('154'));

        openTab(/credits/i);
        fireEvent.change(screen.getByLabelText('Inker'), { target: { value: 'Ink Uno, Ink Due' } });
        openTab(/general/i); // credits content unmounts; state must survive in the form

        fireEvent.click(screen.getByRole('button', { name: /save metadata/i }));
        await waitFor(() => expect(patched).not.toBeNull());

        expect(patched.issueId).toBe('i154');
        expect(patched.inker).toEqual(['Ink Uno', 'Ink Due']);      // the edit, split server-shape
        expect(patched.writers).toEqual(['Luca Enoch']);            // untouched arrays round-trip
        expect(patched.tags).toEqual(['bonelli']);
        expect(patched.gtin).toBe('9791234567897');                 // untouched scalars round-trip
        expect(patched.alternateNumber).toBe('19B');
        expect(patched.communityRating).toBe('4');                  // route parses/clamps
        expect(patched.blackAndWhite).toBe(false);                  // explicit No preserved, not nulled
    });

    it('the tri-state control drives blackAndWhite to null (Unknown) and true (Yes)', async () => {
        render(<MetadataEditorModal {...issueProps} />);
        await waitFor(() => expect((screen.getByLabelText('Number', { selector: 'input' }) as HTMLInputElement).value).toBe('154'));

        openTab(/details/i);
        fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
        expect(screen.getByRole('button', { name: 'Unknown' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: /save metadata/i }));
        await waitFor(() => expect(patched).not.toBeNull());
        expect(patched.blackAndWhite).toBeNull();

        patched = null;
        fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
        fireEvent.click(screen.getByRole('button', { name: /save metadata/i }));
        await waitFor(() => expect(patched).not.toBeNull());
        expect(patched.blackAndWhite).toBe(true);
    });
});
