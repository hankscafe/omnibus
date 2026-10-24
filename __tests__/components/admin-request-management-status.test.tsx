// @vitest-environment jsdom
// Request Management printed AWAITING_RELEASE and MANUAL_DDL raw (only three statuses had a label),
// and "searched everywhere, nothing yet" was indistinguishable from "released, no date known". Both
// lists now take their labels from src/lib/request-status.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/interactive-search-modal', () => ({ InteractiveSearchModal: () => null }));

import { AdminRequestManagement } from '@/components/admin-request-management';

const row = (id: string, status: string, name: string) => ({
    id, status, activeDownloadName: name, seriesName: name, userName: 'reader', volumeId: '101', metadataSource: 'COMICVINE',
    createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z', retryCount: 0,
});

describe('Request Management: status labels', () => {
    beforeEach(() => {
        stubFetchRouter([
            ['/api/admin/requests', () => ok([
                row('r1', 'NOT_FOUND', 'Saga #61'),
                row('r2', 'AWAITING_RELEASE', 'The Dogsitter #2'),
                row('r3', 'MANUAL_DDL', 'X-Men #5'),
                row('r4', 'STALLED', 'Spawn #360'),
            ])],
        ]);
    });

    it('names every status instead of printing the stored value', async () => {
        await act(async () => { render(<AdminRequestManagement />); });

        expect(screen.getAllByText('Not Found Yet').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Awaiting Date').length).toBeGreaterThan(0);
        expect(screen.getAllByText('GetComics Link').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Stalled').length).toBeGreaterThan(0);
        for (const raw of ['NOT_FOUND', 'AWAITING_RELEASE', 'MANUAL_DDL', 'STALLED']) {
            expect(screen.queryByText(raw)).toBeNull();
        }
    });
});
