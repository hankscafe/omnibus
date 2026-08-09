// @vitest-environment jsdom
// #199 duplicate guard: the matcher's "use the comic's own cover art" toggle returns the archive's
// OWN first page as the issue cover. Embedding that back into the file duplicates page 0 — the
// engine's insert-cover is insert-only by design (never replaces). Provenance is decided in the
// dialog (issueCoverFromArchive) and enforced by the page-side gate (shouldEmbedIssueCover):
// genuine uploads embed, the comic's own art never does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SmartMatchMetadataDialog, { shouldEmbedIssueCover } from '@/components/smart-match-metadata-dialog';
import { openTab } from '../helpers/radix';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const ARCHIVE_DATA_URL = 'data:image/jpeg;base64,AQID'; // FileReader base64 of the Blob [1,2,3] below
const UPLOAD_DATA_URL = 'data:image/png;base64,CQkJ';   // FileReader base64 of the File [9,9,9] below

const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    folderPattern: '{Publisher}/{Series} ({Year})',
    showIssueCover: true,
    archiveFilePath: '/library/Unmatched/One-Shot 001.cbz',
};


describe('shouldEmbedIssueCover (#199 gate)', () => {
    it('embeds a genuine upload, honoring the page-level embed toggle', () => {
        expect(shouldEmbedIssueCover({ coverImageBase64: UPLOAD_DATA_URL }, true)).toBe(true);
        expect(shouldEmbedIssueCover({ coverImageBase64: UPLOAD_DATA_URL }, false)).toBe(false);
    });

    it('never embeds an archive-sourced cover, even with the embed toggle on', () => {
        expect(shouldEmbedIssueCover({ coverImageBase64: ARCHIVE_DATA_URL, coverFromArchive: true }, true)).toBeUndefined();
        expect(shouldEmbedIssueCover({ coverImageBase64: ARCHIVE_DATA_URL, coverFromArchive: true }, false)).toBeUndefined();
    });

    it('never embeds when no cover was chosen', () => {
        expect(shouldEmbedIssueCover(undefined, true)).toBeUndefined();
        expect(shouldEmbedIssueCover({}, true)).toBeUndefined();
    });
});

describe('SmartMatchMetadataDialog keep/replace + issue title (#199 round 4 Beta B)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
            json: async () => ({}),
        }));
    });

    const prefill = {
        fields: {
            name: { value: 'Dylan Dog', source: 'comicinfo' },
            writer: { value: 'Tiziano Sclavi', source: 'comicinfo' },
        },
        issue: { number: '1', title: "L'alba dei morti viventi" },
    };
    const seed = { name: 'Provider Name', year: 1986, publisher: 'Provider Pub', description: 'Provider desc' };

    it('keep mode (default) seeds file-first and saves dataMode + the file-prefilled issue title', () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} seed={seed} prefill={prefill} onSave={onSave} />);

        // The files outranked the provider suggestion in the fields…
        expect(screen.getByDisplayValue('Dylan Dog')).toBeTruthy();
        expect(screen.getByDisplayValue("L'alba dei morti viventi")).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /save details/i }));
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            dataMode: 'keep',
            issueTitle: "L'alba dei morti viventi",
            name: 'Dylan Dog',
            writer: 'Tiziano Sclavi',
        }));
    });

    it('replace reseeds provider-fresh, discards file values, and saves dataMode replace', () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} seed={seed} prefill={prefill} onSave={onSave} />);

        fireEvent.click(screen.getByRole('button', { name: /replace with provider data/i }));

        // Provider values took the fields; the files' values are gone (that's what replace means).
        expect(screen.getByDisplayValue('Provider Name')).toBeTruthy();
        expect(screen.queryByDisplayValue('Dylan Dog')).toBeNull();
        expect(screen.queryByDisplayValue("L'alba dei morti viventi")).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /save details/i }));
        const saved = onSave.mock.calls[0][0];
        expect(saved.dataMode).toBe('replace');
        expect(saved.issueTitle).toBeUndefined();
        expect(saved.writer).toBeUndefined();
        expect(saved.name).toBe('Provider Name');
    });
});

describe('SmartMatchMetadataDialog issue-cover provenance (#199)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
        }));
    });

    it('the archive cover saves with issueCoverFromArchive: true', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} onSave={onSave} />);
        openTab(/covers/i);

        // The dialog pulls the archive's first page for the preview…
        await waitFor(() => expect(screen.getByAltText('Issue cover').getAttribute('src')).toBe(ARCHIVE_DATA_URL));
        // …and the admin opts in without uploading anything.
        fireEvent.click(screen.getByRole('switch', { name: /use the comic/i }));
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            issueCoverImageBase64: ARCHIVE_DATA_URL,
            issueCoverFromArchive: true,
        }));
    });

    it('an uploaded image saves WITHOUT the archive flag (still an embed candidate)', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} onSave={onSave} />);
        openTab(/covers/i);
        await waitFor(() => expect(screen.getByAltText('Issue cover')).toBeTruthy());

        const file = new File([Uint8Array.from([9, 9, 9])], 'cover.png', { type: 'image/png' });
        fireEvent.change(screen.getByLabelText(/upload your own/i), { target: { files: [file] } });
        // Uploading flips the opt-in on by itself, and the upload wins over the archive art.
        await waitFor(() => expect(screen.getByAltText('Issue cover').getAttribute('src')).toBe(UPLOAD_DATA_URL));
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        const override = onSave.mock.calls[0][0];
        expect(override.issueCoverImageBase64).toBe(UPLOAD_DATA_URL);
        expect(override.issueCoverFromArchive).toBeUndefined();
    });

    it('"Use the archive\'s cover instead" reverts an upload back to archive provenance', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} onSave={onSave} />);
        openTab(/covers/i);
        await waitFor(() => expect(screen.getByAltText('Issue cover')).toBeTruthy());
        const file = new File([Uint8Array.from([9, 9, 9])], 'cover.png', { type: 'image/png' });
        fireEvent.change(screen.getByLabelText(/upload your own/i), { target: { files: [file] } });
        await waitFor(() => expect(screen.getByAltText('Issue cover').getAttribute('src')).toBe(UPLOAD_DATA_URL));

        fireEvent.click(screen.getByRole('button', { name: /use the archive.s cover instead/i }));
        await waitFor(() => expect(screen.getByAltText('Issue cover').getAttribute('src')).toBe(ARCHIVE_DATA_URL));
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            issueCoverImageBase64: ARCHIVE_DATA_URL,
            issueCoverFromArchive: true,
        }));
    });

    it('reopening an archive-sourced cover keeps provenance even when the re-fetch fails', async () => {
        (fetch as any).mockResolvedValue({ ok: false, status: 415 });
        const onSave = vi.fn();
        const SAVED = 'data:image/jpeg;base64,U0FWRUQ=';
        render(<SmartMatchMetadataDialog {...baseProps} initialIssueCover={SAVED} initialIssueCoverFromArchive onSave={onSave} />);
        openTab(/covers/i);

        // The failed re-render falls back to the previously-saved image (never the upload slot).
        await waitFor(() => expect(screen.getByAltText('Issue cover').getAttribute('src')).toBe(SAVED));
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
            issueCoverImageBase64: SAVED,
            issueCoverFromArchive: true,
        }));
    });

    it('reopening an uploaded cover stays an upload', async () => {
        const onSave = vi.fn();
        const SAVED = 'data:image/png;base64,VVBMT0FE';
        render(<SmartMatchMetadataDialog {...baseProps} initialIssueCover={SAVED} onSave={onSave} />);
        openTab(/covers/i);
        await waitFor(() => expect(screen.getByAltText('Issue cover').getAttribute('src')).toBe(SAVED));
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        const override = onSave.mock.calls[0][0];
        expect(override.issueCoverImageBase64).toBe(SAVED);
        expect(override.issueCoverFromArchive).toBeUndefined();
    });

    it('opt-in off sends no issue cover and no flag', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} onSave={onSave} />);
        openTab(/covers/i);
        await waitFor(() => expect(screen.getByAltText('Issue cover')).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        const override = onSave.mock.calls[0][0];
        expect(override.issueCoverImageBase64).toBeUndefined();
        expect(override.issueCoverFromArchive).toBeUndefined();
    });
});

// #199 (concept by CapitanoNemo78): the tabbed ComicInfo default fields. Strings ride the
// undefined-means-untouched contract (empty → undefined); the B&W switch is a real two-way boolean.
describe('SmartMatchMetadataDialog ComicInfo defaults (#199)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
        }));
    });

    it('saves General-tab defaults trimmed, leaves untouched fields undefined, and always sends the B&W boolean', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} onSave={onSave} />);

        fireEvent.change(screen.getByLabelText('Publisher Imprint'), { target: { value: '  Vertigo  ' } });
        fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'it' } });
        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        const override = onSave.mock.calls[0][0];
        expect(override.imprint).toBe('Vertigo'); // trimmed
        expect(override.languageISO).toBe('it');
        expect(override.format).toBeUndefined();  // empty stays untouched
        expect(override.writer).toBeUndefined();
        expect(override.blackAndWhite).toBe(false); // boolean always present when the dialog saves
    });

    it('Credits-tab fields save as comma-separated text; Details-tab switch flips B&W true', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps} onSave={onSave} />);

        openTab(/credits/i);
        fireEvent.change(screen.getByLabelText('Writer'), { target: { value: 'Scott Snyder, James Tynion IV' } });

        openTab(/details/i);
        fireEvent.click(screen.getByRole('switch', { name: /black and white/i }));

        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        const override = onSave.mock.calls[0][0];
        expect(override.writer).toBe('Scott Snyder, James Tynion IV');
        expect(override.blackAndWhite).toBe(true);
    });

    it('reopening seeds every default field from the saved override', async () => {
        const onSave = vi.fn();
        render(<SmartMatchMetadataDialog {...baseProps}
            initialOverride={{ writer: 'W. Riter', imprint: 'Vertigo', blackAndWhite: true }} onSave={onSave} />);

        fireEvent.click(screen.getByRole('button', { name: /save details/i }));

        const override = onSave.mock.calls[0][0];
        expect(override.writer).toBe('W. Riter');
        expect(override.imprint).toBe('Vertigo');
        expect(override.blackAndWhite).toBe(true);
    });
});

describe('Refresh from number (#199 round 2: right series, wrong issue)', () => {
    const refreshProps = {
        ...baseProps,
        onSave: vi.fn(),
        issueNumber: '4',
        seriesMetadataId: 16180,
        metadataSource: 'METRON',
    };

    beforeEach(() => {
        toast.mockClear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ issues: [{ id: '171947', issue_number: '154', name: 'Dragonero #154' }] }),
            blob: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
        }));
    });

    it('shows the number field for loose files only, wired to the page', () => {
        const onIssueNumberChange = vi.fn();
        const { unmount } = render(<SmartMatchMetadataDialog {...refreshProps} onIssueNumberChange={onIssueNumberChange} />);
        const input = screen.getByLabelText('Issue Number');
        expect((input as HTMLInputElement).value).toBe('4');
        fireEvent.change(input, { target: { value: '154' } });
        expect(onIssueNumberChange).toHaveBeenCalledWith('154');
        unmount();

        render(<SmartMatchMetadataDialog {...refreshProps} showIssueCover={false} />);
        expect(screen.queryByLabelText('Issue Number')).toBeNull();
    });

    it('re-resolves the exact issue id from the corrected number and reports it back', async () => {
        const onIssueIdChange = vi.fn();
        render(<SmartMatchMetadataDialog {...refreshProps} issueNumber="154" onIssueIdChange={onIssueIdChange} />);

        fireEvent.click(screen.getByRole('button', { name: /refresh from number/i }));

        await waitFor(() => expect(onIssueIdChange).toHaveBeenCalledWith('171947'));
        expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/issue-details?id=16180&type=volume&provider=METRON');
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Issue re-matched' }));
    });

    it('guards: blank number and unmatched series toast instead of fetching', async () => {
        const onIssueIdChange = vi.fn();
        const { unmount } = render(<SmartMatchMetadataDialog {...refreshProps} issueNumber="" onIssueIdChange={onIssueIdChange} />);
        fireEvent.click(screen.getByRole('button', { name: /refresh from number/i }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Enter the issue number first' })));
        unmount();
        toast.mockClear();

        render(<SmartMatchMetadataDialog {...refreshProps} seriesMetadataId={undefined} onIssueIdChange={onIssueIdChange} />);
        fireEvent.click(screen.getByRole('button', { name: /refresh from number/i }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No series match yet' })));
        expect(onIssueIdChange).not.toHaveBeenCalled();
    });

    it('an unknown number reports honestly and leaves the binding untouched', async () => {
        const onIssueIdChange = vi.fn();
        render(<SmartMatchMetadataDialog {...refreshProps} issueNumber="999" onIssueIdChange={onIssueIdChange} />);
        fireEvent.click(screen.getByRole('button', { name: /refresh from number/i }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No matching issue found' })));
        expect(onIssueIdChange).not.toHaveBeenCalled();
    });
});
