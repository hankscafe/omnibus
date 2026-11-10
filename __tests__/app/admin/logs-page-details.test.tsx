// @vitest-environment jsdom
// v1.4.11-beta.031 (lint batch 3f): the System Logs page shows one details dialog for both kinds of log,
// telling an audit record (it names an action) from a job log. The check got a name (isAuditLog) and the
// job log's trigger read `durationMs ?? 0` under the new types; these tests pin what the dialog shows for
// each kind (they pass on the page before the batch too).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import LogsPage from '@/app/admin/logs/page';

const JOB = (over: Record<string, unknown>) => ({
    id: 'j1', jobType: 'LIBRARY_SCAN', status: 'COMPLETED', relatedItem: null, durationMs: null, attempts: 1,
    message: 'Scanned 3 series.', createdAt: '2026-11-01T10:00:00.000Z', ...over,
});
const AUDIT = {
    id: 'a1', userId: 'u1', user: { username: 'adam' }, action: 'IGNORE_SERIES', details: '{"seriesIds":["s1"],"updated":1}',
    ipAddress: '10.0.0.5', createdAt: '2026-11-01T11:00:00.000Z',
};

const openTab = async (name: RegExp) => {
    const tab = screen.getByRole('tab', { name });
    await act(async () => { fireEvent.mouseDown(tab); fireEvent.click(tab); });
};
const dialog = () => screen.getByRole('dialog');

describe('System Logs - the details dialog', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    const renderWith = (jobs: unknown[]) => {
        stubFetchRouter([
            ['/api/admin/logs', () => ok([])],
            ['/api/admin/job-logs', () => ok(jobs)],
            ['/api/admin/audit-logs', () => ok([AUDIT])],
            ['/api/admin/config', () => ok({ settings: [] })],
        ]);
        render(<LogsPage />);
    };

    it('shows a job log as one: status, target and how it was triggered', async () => {
        renderWith([JOB({}), JOB({ id: 'j2', jobType: 'METADATA_SYNC', durationMs: 4200, relatedItem: 'Saga' })]);
        await openTab(/Job History/);
        const [first, second] = await screen.findAllByTitle('View Details');

        fireEvent.click(first);
        expect(within(dialog()).getByText('LIBRARY SCAN')).toBeTruthy();
        expect(within(dialog()).getByText('COMPLETED')).toBeTruthy();
        expect(within(dialog()).getByText('Global')).toBeTruthy();
        expect(within(dialog()).getByText('Heartbeat')).toBeTruthy();
        expect(within(dialog()).queryByText('IP Address')).toBeNull();
        fireEvent.click(within(dialog()).getByRole('button', { name: 'Close Details' }));

        fireEvent.click(second);
        expect(within(dialog()).getByText('Saga')).toBeTruthy();
        expect(within(dialog()).getByText('Automatic/UI')).toBeTruthy();
        expect(within(dialog()).getByText('4.2 s')).toBeTruthy();
    });

    it('shows an audit record as one: user, IP and action', async () => {
        renderWith([]);
        await openTab(/Audit Logs/);
        fireEvent.click(await screen.findByTitle('View Full Details'));

        expect(within(dialog()).getByText('Audit Record: IGNORE_SERIES', { exact: false })).toBeTruthy();
        expect(within(dialog()).getByText('adam')).toBeTruthy();
        expect(within(dialog()).getByText('10.0.0.5')).toBeTruthy();
        expect(within(dialog()).queryByText('Heartbeat')).toBeNull();
    });
});
