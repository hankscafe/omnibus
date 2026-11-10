// @vitest-environment jsdom
// v1.4.11-beta.030 (lint batch 3e): the Diagnostics page reads its scans through typed replies, and a
// scan whose reply carries no list (a failed scan answers { error }) now stores null instead of
// undefined. Both read as "not scanned yet"; these tests pin that, a clean scan and a found ghost
// (they pass on the page before the batch too).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import DiagnosticsPage from '@/app/admin/diagnostics/page';

const scanGhosts = async (reply: () => unknown) => {
    const calls: string[] = [];
    stubFetchRouter([['/api/admin/diagnostics', (_u, init) => { calls.push(JSON.parse(init.body).action); return reply(); }]]);
    render(<DiagnosticsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Scan Database/ }));
    await waitFor(() => expect(calls).toEqual(['scan-ghosts']));
    await waitFor(() => expect((screen.getByRole('button', { name: /Scan Database/ }) as HTMLButtonElement).disabled).toBe(false));
};

describe('Diagnostics - the ghost scan', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('says so when the scan finds nothing', async () => {
        await scanGhosts(() => ok({ ghosts: [] }));
        expect(screen.getByText('No ghosts found! Database is perfectly aligned.')).toBeTruthy();
    });

    it('lists what it finds', async () => {
        await scanGhosts(() => ok({ ghosts: [{ id: 's1', type: 'SERIES', name: 'Lost Series', path: '/library/Lost Series' }] }));
        expect(screen.getByText(/Found 1 Ghost Records/)).toBeTruthy();
        expect(screen.queryByText('No ghosts found! Database is perfectly aligned.')).toBeNull();
    });

    it('stays un-scanned when the scan fails (no list in the reply)', async () => {
        await scanGhosts(() => err(500, { error: 'Engine unreachable' }));
        expect(screen.queryByText('No ghosts found! Database is perfectly aligned.')).toBeNull();
        expect(screen.queryByText(/Found \d+ Ghost Records/)).toBeNull();
    });
});
