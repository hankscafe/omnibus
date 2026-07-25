// __tests__/components/page-sweep-modal.test.tsx
//
// Issue #189 Phase 3: the sweep modal's three phases. Scan walks candidates in batches and lands
// on review with every match pre-checked and skipped files noted; confirm posts the selected
// items and flips to the running phase, which renders polled progress and can request cancel.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PageSweepModal from '@/components/page-sweep-modal';

const toastMock = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: toastMock }),
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

const source = { issueId: 'src', filePath: '/c/S 001.cbz', label: 'Series #1', entryName: 'credits.jpg' };

function mockApis({ enqueueOk = true, runStatus = 'RUNNING' } = {}) {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
        if (typeof url === 'string' && url.startsWith('/api/library/issue/pages/sweep/candidates')) {
            return { ok: true, json: async () => ({ seriesName: 'Series', candidates: [
                { issueId: 'src', label: 'Series #1' }, { issueId: 'i2', label: 'Series #2' }, { issueId: 'i3', label: 'Series #3' },
            ] }) };
        }
        if (url === '/api/library/issue/pages/sweep/scan') {
            return { ok: true, json: async () => ({
                matches: [
                    { issueId: 'src', label: 'Series #1', filePath: '/c/S 001.cbz', entryName: 'credits.jpg', index: 5 },
                    { issueId: 'i2', label: 'Series #2', filePath: '/c/S 002.cbz', entryName: 'zz.jpg', index: 3 },
                ],
                skipped: [{ issueId: 'i3', label: 'Series #3', reason: 'not_cbz' }],
                errors: [],
            }) };
        }
        if (url === '/api/library/issue/pages/sweep' && init?.method === 'POST') {
            return enqueueOk
                ? { ok: true, json: async () => ({ success: true, runId: 'run-9', total: 2 }) }
                : { ok: false, status: 409, json: async () => ({ error: 'A page sweep is already running' }) };
        }
        if (url === '/api/library/issue/pages/sweep' && (!init || !init.method)) {
            return { ok: true, json: async () => ({ result: {
                runId: 'run-9', status: runStatus, sourceLabel: 'Series #1 — credits.jpg',
                total: 2, processed: runStatus === 'RUNNING' ? 1 : 2, removed: runStatus === 'RUNNING' ? 1 : 2,
                failedCount: 0, failed: [], startedAt: 1, heartbeatAt: Date.now(),
                ...(runStatus !== 'RUNNING' ? { finishedAt: Date.now() } : {}),
            }, active: runStatus === 'RUNNING' }) };
        }
        if (url === '/api/library/issue/pages/sweep/cancel') {
            return { ok: true, json: async () => ({ success: true }) };
        }
        return { ok: true, json: async () => ({}) };
    });
}

describe('Page sweep modal (issue #189 Phase 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockApis();
    });

    it('scans, then reviews with matches pre-checked and skipped files noted', async () => {
        render(<PageSweepModal open onOpenChange={vi.fn()} source={source} />);

        expect(await screen.findByText(/2 copies found across 2 file/i)).toBeInTheDocument();
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes).toHaveLength(2);
        checkboxes.forEach(c => expect(c).toBeChecked());
        expect(screen.getByText(/1 file skipped \(not CBZ/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Remove 2 Pages/i })).toBeEnabled();
    });

    it('unchecking a match shrinks the selection and the confirm posts only selected items', async () => {
        render(<PageSweepModal open onOpenChange={vi.fn()} source={source} />);
        await screen.findByText(/2 copies found/i);

        fireEvent.click(screen.getAllByRole('checkbox')[0]);
        expect(screen.getByText(/1 page in 1 file selected/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Remove 1 Page$/i }));
        expect(await screen.findByText(/Remove this page everywhere\?/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Start Sweep/i }));

        await waitFor(() => {
            const call = fetchMock.mock.calls.find(([u, init]: any[]) => u === '/api/library/issue/pages/sweep' && init?.method === 'POST');
            expect(call).toBeTruthy();
            const body = JSON.parse(call![1].body);
            expect(body.items).toEqual([{ issueId: 'i2', entryName: 'zz.jpg' }]);
            expect(body.sourceIssueId).toBe('src');
        });
    });

    it('running phase renders polled progress and cancel posts the runId', async () => {
        render(<PageSweepModal open onOpenChange={vi.fn()} source={source} />);
        await screen.findByText(/2 copies found/i);
        fireEvent.click(screen.getByRole('button', { name: /Remove 2 Pages/i }));
        fireEvent.click(await screen.findByRole('button', { name: /Start Sweep/i }));

        expect(await screen.findByText(/Removing… 1 of 2/i)).toBeInTheDocument();
        expect(screen.getByText(/safe to close this window/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Cancel Sweep/i }));
        await waitFor(() => {
            const call = fetchMock.mock.calls.find(([u]: any[]) => u === '/api/library/issue/pages/sweep/cancel');
            expect(call).toBeTruthy();
            expect(JSON.parse(call![1].body)).toEqual({ runId: 'run-9' });
        });
    });

    it('reaches the done summary when the poll reports completion', async () => {
        mockApis({ runStatus: 'COMPLETED' });
        const onApplied = vi.fn();
        render(<PageSweepModal open onOpenChange={vi.fn()} source={source} onApplied={onApplied} />);
        await screen.findByText(/2 copies found/i);
        fireEvent.click(screen.getByRole('button', { name: /Remove 2 Pages/i }));
        fireEvent.click(await screen.findByRole('button', { name: /Start Sweep/i }));

        expect(await screen.findByText(/Done — removed 2 page/i)).toBeInTheDocument();
        await waitFor(() => expect(onApplied).toHaveBeenCalled());
    });
});
