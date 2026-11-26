// @vitest-environment jsdom
// The folder-collision dialog (field report by robotshavehearts2): when a match would land in a
// folder another series already owns, the admin chooses — put the volume under that series as a
// collected edition, or give it a folder name of its own — and nothing happens until they do.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { FolderCollisionDialog } from '@/components/folder-collision-dialog';

// Radix Dialog polyfills for jsdom (the same set the Discover grid tests install).
(global as any).ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
(window as any).PointerEvent = class PointerEvent extends Event {} as any;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const collision = {
    seriesId: 's1', seriesName: 'Saga', year: 2012, publisher: 'Image', metadataSource: 'COMICVINE', metadataId: '49976',
    folderPath: '/comics/Image/Saga (2012)', suggestedFolderName: 'Saga (2012) (2)', volumeName: 'Saga', volumeYear: 2012,
};

describe('FolderCollisionDialog', () => {
    it('says who owns the folder and offers both ways out', () => {
        render(<FolderCollisionDialog open collision={collision} onCancel={vi.fn()} onResolve={vi.fn()} busy={false} />);
        expect(screen.getByText(/which already belongs to/)).toBeTruthy();
        expect(screen.getAllByText(/Saga \(2012\)/).length).toBeGreaterThan(0);
        expect(screen.getByRole('button', { name: /Add it to Saga as a collected edition/ })).toBeTruthy();
        expect((screen.getByLabelText('Folder name') as HTMLInputElement).value).toBe('Saga (2012) (2)');
    });

    it('resolves as an attach, or as a rename with the typed name, and never with a blank one', () => {
        const onResolve = vi.fn();
        render(<FolderCollisionDialog open collision={collision} onCancel={vi.fn()} onResolve={onResolve} busy={false} />);

        fireEvent.click(screen.getByRole('button', { name: /Add it to Saga as a collected edition/ }));
        expect(onResolve).toHaveBeenLastCalledWith({ mode: 'attach' });

        const input = screen.getByLabelText('Folder name');
        fireEvent.change(input, { target: { value: '  Saga (2012) (TPB)  ' } });
        fireEvent.click(screen.getByRole('button', { name: /Use this folder name/ }));
        expect(onResolve).toHaveBeenLastCalledWith({ mode: 'rename', folderName: 'Saga (2012) (TPB)' });

        fireEvent.change(input, { target: { value: '   ' } });
        expect((screen.getByRole('button', { name: /Use this folder name/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('cancels without resolving, and locks both actions while one is in flight', () => {
        const onCancel = vi.fn();
        const onResolve = vi.fn();
        const { rerender } = render(<FolderCollisionDialog open collision={collision} onCancel={onCancel} onResolve={onResolve} busy={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalled();
        expect(onResolve).not.toHaveBeenCalled();

        rerender(<FolderCollisionDialog open collision={collision} onCancel={onCancel} onResolve={onResolve} busy />);
        expect((screen.getByRole('button', { name: /Add it to Saga as a collected edition/ }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /Use this folder name/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    // #285: the volume itself already belongs to another series in a folder of its own. The only
    // ways on are merging into that series or cancelling - no collected-edition attach, no new name.
    describe('the volume is already in the library', () => {
        const volume = {
            kind: 'volume' as const, sourceIsFile: false,
            seriesId: 'sB', seriesName: 'Series B', year: 2016, publisher: 'Pub', metadataSource: 'COMICVINE', metadataId: '12345',
            folderPath: '/comics/Pub/Series B (2016)', suggestedFolderName: '', volumeName: 'Series A', volumeYear: 2016,
        };

        it('names the series and its folder, offers only a merge, and resolves as one', () => {
            const onResolve = vi.fn();
            render(<FolderCollisionDialog open collision={volume} onCancel={vi.fn()} onResolve={onResolve} busy={false} />);

            expect(screen.getByText('This volume is already in your library')).toBeTruthy();
            expect(screen.getAllByText(/Series B \(2016\)/).length).toBeGreaterThan(0);
            expect(screen.getByText(/fix its match first/)).toBeTruthy();
            expect(screen.queryByRole('button', { name: /collected edition/ })).toBeNull();
            expect(screen.queryByLabelText('Folder name')).toBeNull();

            fireEvent.click(screen.getByRole('button', { name: /Merge this folder into Series B/ }));
            expect(onResolve).toHaveBeenLastCalledWith({ mode: 'merge' });
        });

        it('says "this file" for a loose file, and locks the merge while it runs', () => {
            const { rerender } = render(<FolderCollisionDialog open collision={{ ...volume, sourceIsFile: true }} onCancel={vi.fn()} onResolve={vi.fn()} busy={false} />);
            expect(screen.getByRole('button', { name: /Merge this file into Series B/ })).toBeTruthy();

            rerender(<FolderCollisionDialog open collision={{ ...volume, sourceIsFile: true }} onCancel={vi.fn()} onResolve={vi.fn()} busy />);
            expect((screen.getByRole('button', { name: /Merge this file into Series B/ }) as HTMLButtonElement).disabled).toBe(true);
        });
    });
});
