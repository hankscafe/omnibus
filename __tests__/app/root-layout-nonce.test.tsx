// The root layout's two inline scripts - its own anti-flash theme script and next-themes' - must carry the
// request's CSP nonce (the x-nonce header the middleware sets), or the Content-Security-Policy blocks them
// and every page flashes the wrong theme. Rendered on the server, as Next renders it (node environment:
// next-themes puts the nonce on its script only server-side).
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
    headers: new Map<string, string>(),
    // The page chrome isn't under test; next-themes' ThemeProvider is (it renders the second script).
    passThrough: ({ children }: { children?: unknown }) => children,
}));

vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => mocks.headers.get(k.toLowerCase()) ?? null }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/font/google', () => ({ Inter: () => ({ className: 'font-inter', variable: '--font-inter' }) }));
vi.mock('@/app/globals.css', () => ({}));
vi.mock('@/lib/db', () => ({
    prisma: {
        user: { count: async () => 1 },
        systemSetting: { findUnique: async () => ({ value: 'true' }), upsert: vi.fn() },
    },
}));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('@/components/site-footer', () => ({ SiteFooter: () => null }));
vi.mock('@/components/AuthProvider', () => ({ AuthProvider: mocks.passThrough }));
vi.mock('@/components/navigation-wrapper', () => ({ NavigationWrapper: mocks.passThrough }));
vi.mock('@/components/title-manager', () => ({ TitleManager: () => null }));
vi.mock('@/components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('@/components/pwa-registry', () => ({ PwaRegistry: () => null }));

import RootLayout from '@/app/layout';

const render = async () => renderToString(await RootLayout({ children: <p>page</p> }));
const scripts = (html: string) => html.match(/<script[^>]*>/g) ?? [];

describe('Root layout: inline scripts carry the CSP nonce', () => {
    beforeEach(() => { mocks.headers.clear(); mocks.headers.set('x-pathname', '/library'); });

    it('both inline scripts get the nonce from x-nonce', async () => {
        mocks.headers.set('x-nonce', 'n0nce+abc/123==');
        const html = await render();

        const tags = scripts(html);
        expect(tags).toHaveLength(2);
        for (const tag of tags) expect(tag).toContain('nonce="n0nce+abc/123=="');
        expect(html).toContain('omnibus-color-theme'); // the layout's own theme script is one of them
        expect(html).toContain('<p>page</p>');
    });

    it('without a nonce (OMNIBUS_CSP=off) the scripts still render, just without one', async () => {
        const html = await render();

        const tags = scripts(html);
        expect(tags).toHaveLength(2);
        for (const tag of tags) expect(tag).not.toContain('nonce=');
    });
});
