// #199 series-editor tabs: the post-match home of the ComicInfo defaults. These tests pin the
// load → edit → save round-trip: values seed from the series API's comicInfo bag (list columns
// joined to comma text), edits post through library/update with every field present (editor
// semantics: an emptied field is an explicit clear), and the loaded values a user never touched
// round-trip unchanged — so a description-only save can't wipe provider genres or stored defaults.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MetadataEditorModal from '@/components/metadata-editor-modal';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

// Radix tabs: inactive content unmounts and TabsTrigger activates on mousedown — open with the
// full event sequence (house rule from the beta.012 suite).
const openTab = (name: RegExp) => {
    const trigger = screen.getByRole('tab', { name });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
};

const ok = (body: any) => Promise.resolve({ ok: true, json: async () => body });

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
        vi.clearAllMocks();
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
