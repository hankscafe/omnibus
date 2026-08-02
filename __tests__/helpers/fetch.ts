// __tests__/helpers/fetch.ts
//
// fetch/timer stubs (beta.014 test refactor). `ok()`/`err()` are the minimal Response-ish shapes
// component tests await; `stubFetchRouter` replaces the per-file if/startsWith fetch routers.
// Remember vi.unstubAllGlobals() in afterEach when a file stubs globals outside beforeEach.
import { vi } from 'vitest';

export const ok = (body: any) => Promise.resolve({ ok: true, json: async () => body });
export const err = (status: number, body: any = {}) =>
    Promise.resolve({ ok: false, status, json: async () => body });

/** Routes fetch by first-match prefix (string) or pattern (RegExp); unmatched URLs resolve ok({}). */
export const stubFetchRouter = (routes: Array<[string | RegExp, (url: string, init?: any) => any]>) => {
    const fn = vi.fn((url: any, init?: any) => {
        const u = String(url);
        for (const [matcher, handler] of routes) {
            if (typeof matcher === 'string' ? u.startsWith(matcher) : matcher.test(u)) return handler(u, init);
        }
        return ok({});
    });
    vi.stubGlobal('fetch', fn);
    return fn;
};

/** Collapses setTimeout delays to the next tick — for retry/backoff code under test. */
export const stubImmediateTimers = () => {
    const originalSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((cb: any) => originalSetTimeout(cb, 0)) as any);
};
