// @vitest-environment jsdom
// PwaRegistry registers the service worker (public/sw.js: an offline page instead of the browser's error)
// in production builds. Until beta.036 it waited for window "load" from inside an effect - and effects
// run after hydration, by which time "load" has usually fired already, so the listener never ran and the
// worker was never registered (seen in the beta.035 lab walk). It now registers at once when the page has
// already loaded, and on "load" otherwise.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { PwaRegistry } from '@/components/pwa-registry';

let readyState: DocumentReadyState;
let register: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    readyState = 'complete';
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => readyState });
    register = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // @ts-expect-error - remove the stand-in again
    delete navigator.serviceWorker;
});

const mount = async () => { let r!: ReturnType<typeof render>; await act(async () => { r = render(<PwaRegistry />); }); return r; };
const fireLoad = async () => { await act(async () => { window.dispatchEvent(new Event('load')); }); };

describe('PwaRegistry', () => {
    it('registers the worker at once when the page has already loaded (the usual case after hydration)', async () => {
        await mount();

        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith('/sw.js');
    });

    it('waits for "load" while the page is still loading, then registers once', async () => {
        readyState = 'loading';
        await mount();
        expect(register).not.toHaveBeenCalled();

        await fireLoad();
        await fireLoad();

        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith('/sw.js');
    });

    it('does not register later if it unmounts before the page loads', async () => {
        readyState = 'interactive';
        const { unmount } = await mount();
        unmount();

        await fireLoad();

        expect(register).not.toHaveBeenCalled();
    });

    it('never registers outside production builds', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        await mount();
        await fireLoad();

        expect(register).not.toHaveBeenCalled();
    });

    it('does nothing where the browser has no service workers', async () => {
        // @ts-expect-error - a browser without the API
        delete navigator.serviceWorker;
        await mount();

        expect('serviceWorker' in navigator).toBe(false);
    });

    it('logs a failed registration instead of throwing', async () => {
        const failure = new Error('blocked');
        register.mockRejectedValueOnce(failure);
        await mount();

        expect(console.error).toHaveBeenCalledWith('PWA Service Worker registration failed: ', failure);
    });

    it('logs a successful one', async () => {
        await mount();

        expect(console.log).toHaveBeenCalledWith('PWA Service Worker registered.');
    });
});
