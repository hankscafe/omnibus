// __tests__/api/opds-pinned.test.ts
//
// #262: the Komga-flavoured feed under /komga/opds/v1.2 is built by the same handlers as /api/opds.
// These snapshots pin every /api/opds feed byte for byte — taken before the flavour existed — so the
// existing feed provably stays exactly as it was for the clients that already read it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getRoot } from '@/app/api/opds/route';
import { GET as getSeriesList } from '@/app/api/opds/series/route';
import { GET as getSeries } from '@/app/api/opds/series/[id]/route';
import { GET as getSection } from '@/app/api/opds/sections/[name]/route';
import { GET as getSearch } from '@/app/api/opds/search/route';
import { GET as getOpenSearch } from '@/app/api/opds/opensearch/route';
import { stockOpdsPrisma } from '../helpers/opds-fixtures';

const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    prisma: {
        series: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), groupBy: vi.fn() },
        library: { count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
        issue: { findMany: vi.fn(), update: vi.fn() },
        readProgress: { findMany: vi.fn() },
    },
    inProgressBooks: vi.fn(),
    onDeckBooks: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({ prisma: mocks.prisma }));
vi.mock('@/lib/library-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/library-access')>()),
    getAccessibleLibraryIds: vi.fn(async () => 'ALL'),
}));
vi.mock('@/lib/komga/data', () => ({ inProgressBooks: mocks.inProgressBooks, onDeckBooks: mocks.onDeckBooks }));

const req = (path: string) => new Request(`http://localhost${path}`, { headers: { authorization: 'Basic cmVhZGVyOmtleQ==' } });
const snap = (name: string) => `./__snapshots__/opds-pinned/${name}`;

beforeEach(() => {
    mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', username: 'reader', role: 'USER' }, keyType: 'OPDS_KEY' });
    stockOpdsPrisma(mocks.prisma);
    mocks.inProgressBooks.mockResolvedValue({ content: [{ id: 'iss_1' }] });
    mocks.onDeckBooks.mockResolvedValue({ content: [{ id: 'iss_2' }] });
});

describe('/api/opds is pinned byte for byte (#262)', () => {
    it('the root catalog', async () => {
        const res = await getRoot(req('/api/opds'));
        expect(res.headers.get('content-type')).toMatchInlineSnapshot(`"application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8"`);
        await expect(await res.text()).toMatchFileSnapshot(snap('root.xml'));
    });

    it('the series list, whole and one library\'s', async () => {
        await expect(await (await getSeriesList(req('/api/opds/series'))).text()).toMatchFileSnapshot(snap('series.xml'));
        await expect(await (await getSeriesList(req('/api/opds/series?library=lib_1&page=2'))).text()).toMatchFileSnapshot(snap('series-library.xml'));
    });

    it('a series feed: the run, an annual and a Special, with progress', async () => {
        const res = await getSeries(req('/api/opds/series/ser_1'), { params: Promise.resolve({ id: 'ser_1' }) });
        await expect(await res.text()).toMatchFileSnapshot(snap('series-ser_1.xml'));
    });

    it.each(['continue', 'recent', 'ondeck', 'libraries'])('the %s section', async (name) => {
        const res = await getSection(req(`/api/opds/sections/${name}`), { params: Promise.resolve({ name }) });
        await expect(await res.text()).toMatchFileSnapshot(snap(`section-${name}.xml`));
    });

    it('a search, and the OpenSearch description', async () => {
        await expect(await (await getSearch(req('/api/opds/search?q=tower'))).text()).toMatchFileSnapshot(snap('search.xml'));
        await expect(await (await getOpenSearch(req('/api/opds/opensearch'))).text()).toMatchFileSnapshot(snap('opensearch.xml'));
    });
});
