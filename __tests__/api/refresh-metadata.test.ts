import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/library/refresh-metadata/route';
import { metronCreditCandidatesWhere } from '@/lib/metron/credit-candidates';

// Metron beta 4 (#216 follow-up): a series' Refresh Metadata no longer fetches per-issue Metron
// credits on its own while the "per-issue credits" setting is off. The button first asks this route
// how many issues on disk are missing them, offers that count ("about N Metron requests"), and the
// refresh carries the answer.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    seriesFindFirst: vi.fn(),
    issueCount: vi.fn(),
    settingFindUnique: vi.fn(),
    queueAdd: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findFirst: mocks.seriesFindFirst },
        issue: { count: mocks.issueCount },
        systemSetting: { findUnique: mocks.settingFindUnique },
    },
}));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.queueAdd } }));

const METRON_SERIES = { id: 's1', name: 'Saga', metadataId: '4000', metadataSource: 'METRON' };
const get = (qs: string) => GET(new Request(`http://localhost/api/library/refresh-metadata?${qs}`));
const post = (body: any) => POST(new Request('http://localhost/api/library/refresh-metadata', { method: 'POST', body: JSON.stringify(body) }));
const setting = (value: string | null) => mocks.settingFindUnique.mockImplementation(async ({ where }: any) =>
    where.key === 'metron_detail_credits' && value !== null ? { key: where.key, value } : null);

describe('/api/library/refresh-metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.seriesFindFirst.mockResolvedValue(METRON_SERIES);
        mocks.issueCount.mockResolvedValue(340);
        setting(null);
    });

    describe('GET - the count behind the ask', () => {
        it('counts the Metron issues on disk still missing their details, with the setting off', async () => {
            const res = await get('metadataId=4000&metadataSource=METRON');

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ creditsEnabled: false, missingCredits: 340 });
            expect(mocks.issueCount).toHaveBeenCalledWith({ where: metronCreditCandidatesWhere('s1') });
        });

        it('says when the setting is on (every sync fetches them - nothing to ask)', async () => {
            setting('true');
            expect(await (await get('metadataId=4000&metadataSource=METRON')).json()).toMatchObject({ creditsEnabled: true });
        });

        it('a ComicVine series has nothing to ask about', async () => {
            mocks.seriesFindFirst.mockResolvedValue({ ...METRON_SERIES, metadataSource: 'COMICVINE' });

            expect(await (await get('metadataId=4000&metadataSource=COMICVINE')).json()).toEqual({ creditsEnabled: false, missingCredits: 0 });
            expect(mocks.issueCount).not.toHaveBeenCalled();
        });

        it('is for admins only, and needs a known series', async () => {
            mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
            expect((await get('metadataId=4000&metadataSource=METRON')).status).toBe(403);

            mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
            mocks.seriesFindFirst.mockResolvedValue(null);
            expect((await get('metadataId=4000&metadataSource=METRON')).status).toBe(404);
            expect((await get('metadataSource=METRON')).status).toBe(400);
        });
    });

    describe('POST - the refresh', () => {
        it('carries a yes to the ask as fetchCredits', async () => {
            await post({ metadataId: '4000', metadataSource: 'METRON', fetchCredits: true });

            expect(mocks.queueAdd).toHaveBeenCalledWith('METADATA_SYNC', { type: 'METADATA_SYNC', seriesIds: ['s1'], fetchCredits: true }, expect.anything());
        });

        it('without one, the refresh follows the setting', async () => {
            await post({ metadataId: '4000', metadataSource: 'METRON' });
            await post({ metadataId: '4000', metadataSource: 'METRON', fetchCredits: 'yes' });

            for (const [, data] of mocks.queueAdd.mock.calls) expect(data).toEqual({ type: 'METADATA_SYNC', seriesIds: ['s1'] });
        });
    });
});
