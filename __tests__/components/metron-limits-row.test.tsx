// @vitest-environment jsdom
// __tests__/components/metron-limits-row.test.tsx
//
// The System Health modal's Metron row (Metron beta 3): the account's real limits - supporter tier,
// daily window, per-minute burst limit - from the shared state, re-read while the modal is open, with
// live countdowns to the reset and to the end of a pause.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetronLimitsRow } from '@/components/metron-limits-row';

const T0 = Date.UTC(2026, 8, 29, 21, 0, 0);
const inS = (s: number) => Math.floor(T0 / 1000) + s;

const snapshot = (status: any, extra: any = {}) => ({ status, localCalls24h: 0, rateLimitFlagMs: 0, nowMs: T0, ...extra });
const check = (metron: any) => ({ id: 'metron_limit', name: 'Metron.Cloud API', status: 'ok' as const, message: 'from the last health run', metron });

let fetchMock: ReturnType<typeof vi.fn>;
// The route answers with the server's clock at response time.
const serve = (body: any) => fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ ...body, nowMs: Date.now() }) }));
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

describe('MetronLimitsRow', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('shows the supporter tier, the day\'s window, the burst limit, and counts down to the reset', async () => {
        const s = snapshot({ burst: { limit: 60, remaining: 59, reset: inS(30) }, sustained: { limit: 10_000, remaining: 8_200, reset: inS(3600) }, updatedAt: T0 - 5_000 });
        serve(s);
        render(<MetronLimitsRow check={check(s)} />);
        await flush();

        expect(fetchMock).toHaveBeenCalledWith('/api/admin/metron-status', expect.anything());
        expect(screen.getByText(/Supporter/)).toBeInTheDocument();
        expect(screen.getByText(/10,000 per day/)).toBeInTheDocument();
        expect(screen.getByText(/8,200 of 10,000 left/)).toBeInTheDocument();
        expect(screen.getByText(/60 per minute/)).toBeInTheDocument();
        expect(screen.getByText('1:00:00')).toBeInTheDocument();

        await act(async () => { vi.advanceTimersByTime(1_000); });
        expect(screen.getByText('59:59')).toBeInTheDocument(); // m:ss under an hour
    });

    it('a standard account says so, and how supporters get more', async () => {
        const s = snapshot({ burst: {}, sustained: { limit: 5_000, remaining: 4_990, reset: inS(3600) } });
        serve(s);
        render(<MetronLimitsRow check={check(s)} />);
        await flush();

        expect(screen.getByText(/Standard/)).toBeInTheDocument();
        expect(screen.getByText(/supporters/i)).toBeInTheDocument();
    });

    it('while Metron has Omnibus paused: an alert with a live countdown, and the row turns red', async () => {
        const s = snapshot({ burst: {}, sustained: { limit: 5_000, remaining: 4_000, reset: inS(3600) }, blockedUntil: T0 + 90_000 });
        serve(s);
        const { container } = render(<MetronLimitsRow check={check(s)} />);
        await flush();

        expect(screen.getByRole('alert')).toHaveTextContent(/paused/i);
        expect(screen.getByRole('alert')).toHaveTextContent('1:30');
        expect(container.querySelector('[data-status="error"]')).not.toBeNull();

        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getByRole('alert')).toHaveTextContent('1:00');
    });

    it('when the daily limit is used up: an alert counting down to the reset', async () => {
        const s = snapshot({ burst: {}, sustained: { limit: 5_000, remaining: 0, reset: inS(2 * 3600) } });
        serve(s);
        render(<MetronLimitsRow check={check(s)} />);
        await flush();

        expect(screen.getByRole('alert')).toHaveTextContent(/daily limit reached/i);
        expect(screen.getByRole('alert')).toHaveTextContent('2:00:00');
    });

    it('re-reads the limits every 30 seconds while open', async () => {
        const s = snapshot({ burst: {}, sustained: { limit: 5_000, remaining: 4_990, reset: inS(3600) } });
        serve(s);
        render(<MetronLimitsRow check={check(s)} />);
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        serve(snapshot({ burst: {}, sustained: { limit: 5_000, remaining: 4_000, reset: inS(3600) } }));
        await act(async () => { vi.advanceTimersByTime(30_000); });
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(screen.getByText(/4,000 of 5,000 left/)).toBeInTheDocument();
    });

    it('keeps the last health run\'s numbers when the live read fails', async () => {
        const s = snapshot({ burst: {}, sustained: { limit: 7_500, remaining: 7_000, reset: inS(3600) } });
        fetchMock.mockRejectedValue(new Error('offline'));
        render(<MetronLimitsRow check={check(s)} />);
        await flush();

        expect(screen.getByText(/7,000 of 7,500 left/)).toBeInTheDocument();
    });
});
