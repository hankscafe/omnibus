// __tests__/lib/hosters/getcomics-redirect.test.ts
//
// #209 (anacronismo): GetComics hides some mirror buttons (PixelDrain on his page) behind its own
// getcomics.org/dls/ redirect. The engine now classifies such a button by its label, so Node can
// receive a candidate { hoster: 'pixeldrain', url: 'https://getcomics.org/dls/…' } — a URL the
// PixelDrain resolver cannot read (it needs /u/<id>). Before handing a third-party hoster its link,
// the redirect is followed through the engine (which owns the Cloudflare warm-up/solver) and the
// landed URL is what the resolver gets. GetComics' own hosters never take the hop: the engine
// streams those links itself.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isGetComicsRedirect, resolveGetComicsRedirect, resolveHosterUrl } from '@/lib/hosters/getcomics-redirect';

const mocks = vi.hoisted(() => ({
    engineFetchLong: vi.fn(),
}));

vi.mock('@/lib/engine', () => ({
    ENGINE_URL: 'http://engine.test:8000',
    engineHeaders: (extra?: Record<string, string>) => ({ ...(extra || {}), 'X-Internal-Secret': 'shh' }),
    engineFetchLong: mocks.engineFetchLong,
}));

const REDIRECT = 'https://getcomics.org/dls//zKRpBms3pRy1Ss2GLcy2a4lbzTzOkKhDUZJpNj2PmOcSTNgpnJXNfPyf/PU6:A8fB3M==';

function engineAnswers(body: unknown, ok = true, status = 200) {
    mocks.engineFetchLong.mockResolvedValue({ ok, status, json: async () => body });
}

describe('#209 GetComics redirect: recognising the link', () => {
    it('is a getcomics.org /dls/ link and nothing else', () => {
        expect(isGetComicsRedirect(REDIRECT)).toBe(true);
        expect(isGetComicsRedirect('https://getcomics.org/dls/abc')).toBe(true);
        expect(isGetComicsRedirect('https://www.getcomics.org/dls/abc')).toBe(true);
        expect(isGetComicsRedirect('https://pixeldrain.com/u/abc')).toBe(false);
        expect(isGetComicsRedirect('https://getcomics.org/2026/09/wolverine-28-2026/')).toBe(false);
        expect(isGetComicsRedirect('https://comicfiles.ru/x.cbz')).toBe(false);
        expect(isGetComicsRedirect('not a url')).toBe(false);
    });
});

describe('#209 GetComics redirect: resolving through the engine', () => {
    beforeEach(() => {
        mocks.engineFetchLong.mockReset();
    });

    it('asks the engine to follow the redirect and returns the landed hoster URL', async () => {
        engineAnswers({ success: true, landed_url: 'https://pixeldrain.com/u/Ab12Cd' });

        const landed = await resolveGetComicsRedirect(REDIRECT);

        expect(landed).toBe('https://pixeldrain.com/u/Ab12Cd');
        expect(mocks.engineFetchLong).toHaveBeenCalledTimes(1);
        const [url, init] = mocks.engineFetchLong.mock.calls[0];
        expect(url).toBe('http://engine.test:8000/api/getcomics/resolve');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Internal-Secret']).toBe('shh');
        expect(JSON.parse(init.body)).toEqual({ url: REDIRECT });
    });

    it('throws with the engine\'s reason when the redirect never left GetComics', async () => {
        engineAnswers({ success: false, error: 'redirect stayed on getcomics.org (challenge not cleared)' });
        await expect(resolveGetComicsRedirect(REDIRECT)).rejects.toThrow(/challenge not cleared/);
    });

    it('throws on a non-OK engine response', async () => {
        engineAnswers({}, false, 502);
        await expect(resolveGetComicsRedirect(REDIRECT)).rejects.toThrow(/502/);
    });

    it('throws when the engine answers success without a landed URL', async () => {
        engineAnswers({ success: true });
        await expect(resolveGetComicsRedirect(REDIRECT)).rejects.toThrow(/no landed URL/i);
    });
});

describe('#209 GetComics redirect: the hop a third-party hoster takes before its resolver', () => {
    beforeEach(() => {
        mocks.engineFetchLong.mockReset();
    });

    it('leaves a link that already names its host alone', async () => {
        await expect(resolveHosterUrl('https://pixeldrain.com/u/Ab12Cd', 'pixeldrain')).resolves.toBe('https://pixeldrain.com/u/Ab12Cd');
        expect(mocks.engineFetchLong).not.toHaveBeenCalled();
    });

    it('leaves GetComics\' own hosters alone even on a /dls/ link (the engine streams those itself)', async () => {
        for (const hoster of ['getcomics_main', 'getcomics_direct', 'getcomics']) {
            await expect(resolveHosterUrl(REDIRECT, hoster)).resolves.toBe(REDIRECT);
        }
        expect(mocks.engineFetchLong).not.toHaveBeenCalled();
    });

    it('follows the redirect for a mirror hoster and hands back the landed URL', async () => {
        engineAnswers({ success: true, landed_url: 'https://pixeldrain.com/u/Ab12Cd' });
        await expect(resolveHosterUrl(REDIRECT, 'pixeldrain')).resolves.toBe('https://pixeldrain.com/u/Ab12Cd');
        expect(mocks.engineFetchLong).toHaveBeenCalledTimes(1);
    });

    it('propagates a resolve failure so the caller moves to the next candidate', async () => {
        engineAnswers({ success: false, error: 'still on getcomics' });
        await expect(resolveHosterUrl(REDIRECT, 'mega')).rejects.toThrow(/still on getcomics/);
    });
});
