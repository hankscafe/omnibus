// @vitest-environment jsdom
// The header bell (lint batch 3i, v1.4.11-beta.038): each entry as /api/notifications sends it - a request
// that finished reads "Available Now", one still under way "Approved & Downloading", a trophy its name.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const sessionState = vi.hoisted(() => ({ data: { user: { id: 'u1', name: 'reader', role: 'USER', canRequest: true } }, status: 'authenticated', update: () => {} }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionState, signOut: vi.fn() }));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn(), resolvedTheme: 'light' }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { SiteHeader } from '@/components/site-header';

const NOW = '2026-11-12T12:00:00.000Z';
const NOTIFICATIONS = [
    { id: 'r1', type: 'comic', status: 'IMPORTED', title: 'Saga #61', imageUrl: null, date: NOW },
    { id: 'r2', type: 'comic', status: 'DOWNLOADING', title: 'Saga #62', imageUrl: null, date: NOW },
    { id: 'r3', type: 'comic', title: 'Saga #63', imageUrl: null, date: NOW },
    { id: 't1', type: 'trophy', title: 'Bookworm', description: 'Read 100 issues', imageUrl: null, date: NOW },
];

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(String(url).startsWith('/api/notifications')
        ? { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => NOTIFICATIONS }
        : { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) })));
});

describe('Header bell', () => {
    it('reads each request by its status, and a trophy by its name', async () => {
        await act(async () => { render(<SiteHeader />); });
        await act(async () => { await new Promise(r => setTimeout(r, 25)); });

        const bell = document.querySelector('.lucide-bell')?.closest('button') as HTMLElement;
        await act(async () => { fireEvent.keyDown(bell, { key: 'Enter' }); });

        expect(screen.getByText('Saga #61')).toBeInTheDocument();
        // Finished: one; still under way, or no status at all: the other two.
        expect(screen.getAllByText('Available Now')).toHaveLength(1);
        expect(screen.getAllByText('Approved & Downloading')).toHaveLength(2);
        expect(screen.getByText('Trophy Unlocked: Bookworm')).toBeInTheDocument();
    });
});
