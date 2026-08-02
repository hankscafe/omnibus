// @vitest-environment jsdom
// __tests__/components/session-activity-tracker.test.tsx
//
// With the jwt callback no longer counting ambient session reads as activity, this tracker is
// the ONLY thing that slides the inactivity window: it calls useSession().update() on genuine
// user input, throttled so we don't hammer /api/auth/session on every keystroke.
import '@testing-library/jest-dom';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionActivityTracker } from '@/components/AuthProvider';

const mocks = vi.hoisted(() => ({
    useSession: vi.fn(),
    update: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
    useSession: mocks.useSession,
    SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('Component: SessionActivityTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.update.mockResolvedValue(null);
        mocks.useSession.mockReturnValue({
            data: { user: { id: 'admin_1', role: 'ADMIN' } },
            update: mocks.update,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('pings the session on the first genuine user input after mount', () => {
        render(<SessionActivityTracker />);

        fireEvent.pointerDown(window);

        expect(mocks.update).toHaveBeenCalledTimes(1);
    });

    it('throttles: rapid follow-up input does not ping again', () => {
        render(<SessionActivityTracker />);

        fireEvent.pointerDown(window);
        fireEvent.keyDown(window, { key: 'a' });
        act(() => { vi.advanceTimersByTime(60 * 1000); }); // 1 minute later
        fireEvent.pointerDown(window);

        expect(mocks.update).toHaveBeenCalledTimes(1);
    });

    it('pings again once the throttle interval has elapsed', () => {
        render(<SessionActivityTracker />);

        fireEvent.pointerDown(window);
        act(() => { vi.advanceTimersByTime(5 * 60 * 1000 + 1000); }); // past the 5-minute throttle
        fireEvent.keyDown(window, { key: 'a' });

        expect(mocks.update).toHaveBeenCalledTimes(2);
    });

    it('does nothing without an authenticated session', () => {
        mocks.useSession.mockReturnValue({ data: null, update: mocks.update });
        render(<SessionActivityTracker />);

        fireEvent.pointerDown(window);
        fireEvent.keyDown(window, { key: 'a' });

        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('stops listening after unmount', () => {
        const { unmount } = render(<SessionActivityTracker />);
        unmount();

        fireEvent.pointerDown(window);

        expect(mocks.update).not.toHaveBeenCalled();
    });
});
