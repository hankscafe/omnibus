// __tests__/lib/request-fulfilment.test.ts
//
// beta.009: a request closes once its issue is in the library, whichever way the file got there. The
// Smart Matcher asks for the series it just matched; the Series Monitor asks for every parked request
// before it re-searches any of them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifierSendAlert } from '../helpers/setup-global';
import { prisma } from '@/lib/db';
import { requestKind, closeRequestsFulfilledBySeries, closeFulfilledParkedRequests, markRequestsCompleted } from '@/lib/request-fulfilment';

type Row = Record<string, unknown>;

// An in-memory library the mocked Prisma answers from, honouring each query's `where` (OR / AND,
// in / notIn / not, nested relation filters) - so a status, a provider or an id the module doesn't
// ask for is never returned, and dropping one from its query fails these tests.
const db = vi.hoisted(() => ({
    requests: [] as Record<string, unknown>[],
    series: [] as Record<string, unknown>[],
    attachedVolumes: [] as Record<string, unknown>[],
    issues: [] as Record<string, unknown>[],
    coverage: new Map<string, string[]>(),
}));

function matches(row: unknown, where: Row | undefined): boolean {
    if (!where) return true;
    if (!row || typeof row !== 'object') return false;
    const have = row as Row;
    return Object.entries(where).every(([key, want]) => {
        if (key === 'OR') return (want as Row[]).some(w => matches(have, w));
        if (key === 'AND') return (want as Row[]).every(w => matches(have, w));
        if (key === 'NOT') return !matches(have, want as Row);
        const value = have[key];
        if (want && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
            const w = want as Row;
            if ('in' in w || 'notIn' in w || 'not' in w) {
                if ('in' in w && !(w.in as unknown[]).includes(value)) return false;
                if ('notIn' in w && (w.notIn as unknown[]).includes(value)) return false;
                if ('not' in w && (w.not === null ? value == null : value === w.not)) return false;
                return true;
            }
            return matches(value, w);
        }
        return value === want;
    });
}

vi.mock('@/lib/db', () => ({
    prisma: {
        request: {
            findMany: vi.fn(async ({ where }: { where?: Row }) => db.requests.filter(r => matches(r, where))),
            updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
                const hit = db.requests.filter(r => matches(r, where));
                for (const r of hit) Object.assign(r, data);
                return { count: hit.length };
            }),
        },
        series: {
            findMany: vi.fn(async ({ where }: { where?: Row }) => db.series.filter(s => matches(s, where))),
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
                const s = db.series.find(x => x.id === where.id);
                return s ? { ...s, attachedVolumes: db.attachedVolumes.filter(a => a.seriesId === s.id) } : null;
            }),
        },
        attachedVolume: {
            findMany: vi.fn(async ({ where }: { where?: Row }) =>
                db.attachedVolumes.filter(a => matches(a, where)).map(a => ({ ...a, series: db.series.find(s => s.id === a.seriesId) }))),
        },
        issue: {
            findMany: vi.fn(async ({ where }: { where?: Row }) => db.issues.filter(i => matches(i, where))),
        },
    },
}));

vi.mock('@/lib/coverage-ownership', () => ({
    ownedCoverageBySeries: vi.fn(async () => db.coverage),
}));

const nicolas = { userId: 'u_nicolas', user: { username: 'nicolas', email: 'n@example.test' } };
const adam = { userId: 'u_adam', user: { username: 'adam', email: 'a@example.test' } };

const seriesRow = (over: Row = {}): Row => ({
    id: 's_batman', name: 'Batman', publisher: 'DC Comics', year: 2016, isManga: false,
    metadataId: '1234', metadataSource: 'COMICVINE', cvId: null, metronId: null, ...over,
});
const requestRow = (id: string, over: Row = {}): Row => ({
    id, status: 'NOT_FOUND', volumeId: '1234', metadataSource: 'COMICVINE', issueNumber: '37',
    activeDownloadName: 'Batman #37', imageUrl: null, ...nicolas, ...over,
});
const fileRow = (number: string, over: Row = {}): Row => ({
    seriesId: 's_batman', number, isAnnual: false, attachedVolumeId: null, name: null, attachedVolume: null,
    filePath: `/comics/DC Comics/Batman (2016)/Batman #${number.padStart(3, '0')}.cbz`, ...over,
});

const closedIds = () =>
    (vi.mocked(prisma.request.updateMany).mock.calls as unknown as [{ where: { id: { in: string[] } } }][])
        .flatMap(([args]) => args.where.id.in)
        .sort();

beforeEach(() => {
    db.requests = [];
    db.series = [seriesRow()];
    db.attachedVolumes = [];
    db.issues = [];
    db.coverage = new Map();
});

describe('requestKind', () => {
    const batman = { name: 'Batman', isManga: false };

    it('reads a plain request as a single issue', () => {
        expect(requestKind('Batman #37', batman, [])).toBe('issue');
        expect(requestKind('Batman 037 (2016) (Digital) (Zone-Empire)', batman, [])).toBe('issue');
    });

    it('reads a request named for an annual as the annual, unless the series itself is the annual', () => {
        expect(requestKind('Batman Annual #1', batman, [])).toBe('annual');
        expect(requestKind('Batman Annual #1', { name: 'Batman Annual', isManga: false }, [])).toBe('issue');
    });

    it("reads a request named after one of the series' collected books as that book", () => {
        expect(requestKind('Batman: The Court of Owls', batman, ['Batman: The Court of Owls'])).toBe('collected');
    });

    it('reads a Vol. or TPB name as a collected book only where the series has collected books, and never for manga', () => {
        expect(requestKind('Batman Vol. 1 TPB', batman, ['Batman: The Court of Owls'])).toBe('collected');
        expect(requestKind('Batman Vol. 1 TPB', batman, [])).toBe('issue');
        expect(requestKind('Naruto Vol. 3', { name: 'Naruto', isManga: true }, ['Naruto: 3-in-1 Edition'])).toBe('issue');
    });
});

describe('closeRequestsFulfilledBySeries (the Smart Matcher)', () => {
    it('closes a request in every waiting state once its issue is on disk, but never an import still in flight', async () => {
        const open = ['NOT_FOUND', 'AWAITING_RELEASE', 'STALLED', 'UNRELEASED', 'PENDING_APPROVAL', 'MANUAL_DDL', 'PENDING', 'DOWNLOADING', 'NEEDS_REVIEW'];
        db.requests = [...open, 'IMPORTING', 'COMPLETED', 'CANCELLED'].map(status => requestRow(`req_${status}`, { status }));
        db.issues = [fileRow('37')];

        expect(await closeRequestsFulfilledBySeries('s_batman')).toBe(open.length);

        expect(closedIds()).toEqual(open.map(s => `req_${s}`).sort());
        // Un-notified, so the "available" bell fires - the importer closes its requests the same way.
        expect(prisma.request.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: { status: 'COMPLETED', progress: 100, notified: false },
        }));
        expect(db.requests.find(r => r.id === 'req_IMPORTING')?.status).toBe('IMPORTING');
    });

    it('finds the issue by the number the request stored, not by a pack title (#240)', async () => {
        db.requests = [requestRow('req_37', { status: 'NEEDS_REVIEW', activeDownloadName: 'Batman #31-40 (2016)' })];
        db.issues = [fileRow('37')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_37']);
    });

    it('leaves a request open while its issue is not on disk', async () => {
        db.requests = [requestRow('req_38', { issueNumber: '38', activeDownloadName: 'Batman #38' })];
        db.issues = [fileRow('37'), fileRow('38', { filePath: null })];

        expect(await closeRequestsFulfilledBySeries('s_batman')).toBe(0);

        expect(prisma.request.updateMany).not.toHaveBeenCalled();
        expect(notifierSendAlert).not.toHaveBeenCalled();
    });

    it('never closes a request made against the other provider that only shares the id', async () => {
        db.requests = [requestRow('req_metron', { metadataSource: 'METRON' })];
        db.issues = [fileRow('37')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(prisma.request.updateMany).not.toHaveBeenCalled();
    });

    it("closes a request made against the other provider when the series stores that provider's id", async () => {
        db.series = [seriesRow({ metronId: 987 })];
        db.requests = [requestRow('req_metron', { metadataSource: 'METRON', volumeId: '987' })];
        db.issues = [fileRow('37')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_metron']);
    });

    it("closes an older request that names the series by its local id", async () => {
        db.requests = [requestRow('req_local', { volumeId: 's_batman' })];
        db.issues = [fileRow('37')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_local']);
    });

    it("never closes an annual's request on the run's issue of the same number", async () => {
        db.requests = [
            requestRow('req_annual', { issueNumber: '1', activeDownloadName: 'Batman Annual #1' }),
            requestRow('req_run', { issueNumber: '1', activeDownloadName: 'Batman #1' }),
        ];
        db.issues = [fileRow('1')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_run']);
    });

    it("never closes the run's request on an annual of the same number", async () => {
        db.requests = [
            requestRow('req_annual', { issueNumber: '1', activeDownloadName: 'Batman Annual #1' }),
            requestRow('req_run', { issueNumber: '1', activeDownloadName: 'Batman #1' }),
        ];
        db.issues = [fileRow('1', { isAnnual: true, filePath: '/comics/DC Comics/Batman (2016)/Batman Annual #001.cbz' })];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_annual']);
    });

    it("never closes the run's request on a collected book that shares its number", async () => {
        const court = { kind: 'COLLECTED', name: 'Batman (2011) TPBs' };
        db.requests = [requestRow('req_run', { issueNumber: '1', activeDownloadName: 'Batman #1' })];
        db.issues = [fileRow('1', { attachedVolumeId: 'av_tpb', attachedVolume: court, name: 'Batman: The Court of Owls' })];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(prisma.request.updateMany).not.toHaveBeenCalled();
    });

    it("never closes a collected book's request on the single issue that shares its number", async () => {
        const court = { kind: 'COLLECTED', name: 'Batman (2011) TPBs' };
        db.requests = [requestRow('req_trade', { issueNumber: '1', activeDownloadName: 'Batman: The Court of Owls' })];
        db.issues = [
            fileRow('1'),
            fileRow('1', { attachedVolumeId: 'av_tpb', attachedVolume: court, name: 'Batman: The Court of Owls', filePath: null }),
        ];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(prisma.request.updateMany).not.toHaveBeenCalled();
    });

    it('counts an issue reprinted in a collected edition you own as in the library', async () => {
        db.requests = [requestRow('req_37')];
        db.coverage = new Map([['s_batman', ['36', '37', '38']]]);

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_37']);
    });

    it("closes a request made for one of the series' attached volumes once that volume's issue is on disk", async () => {
        db.attachedVolumes = [{ id: 'av_annual', seriesId: 's_batman', metadataSource: 'COMICVINE', volumeId: '5555', kind: 'ANNUAL', name: 'Batman Annual' }];
        db.requests = [requestRow('req_annual', { volumeId: '5555', issueNumber: '1', activeDownloadName: 'Batman Annual #1' })];
        db.issues = [fileRow('1', { isAnnual: true, attachedVolumeId: 'av_annual', attachedVolume: { kind: 'ANNUAL', name: 'Batman Annual' } })];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(closedIds()).toEqual(['req_annual']);
        expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({ title: 'Batman Annual #1' }));
    });

    // #255: a Special is requested against the parent's volume, under its own name (request-name.ts).
    describe('a Special', () => {
        const arkM = { id: 'av_sp', seriesId: 's_batman', metadataSource: 'COMICVINE', volumeId: '169970', kind: 'SPECIAL', name: 'Batman: Ark-M' };
        const lane = { kind: 'SPECIAL', name: 'Batman: Ark-M' };

        it("closes the Special's request once the Special's own #1 is on disk", async () => {
            db.attachedVolumes = [arkM];
            // The release name the download wrote over the request's name.
            db.requests = [requestRow('req_sp', { issueNumber: '1', activeDownloadName: 'Batman: Ark-M Special #1 (2026)' })];
            db.issues = [fileRow('1', { attachedVolumeId: 'av_sp', attachedVolume: lane, filePath: '/comics/DC Comics/Batman (2016)/Batman Ark-M #001 (2026).cbz' })];

            await closeRequestsFulfilledBySeries('s_batman');

            expect(closedIds()).toEqual(['req_sp']);
            expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({ title: 'Batman: Ark-M #1' }));
        });

        it("never closes the Special's request on the run's #1", async () => {
            db.attachedVolumes = [arkM];
            db.requests = [requestRow('req_sp', { issueNumber: '1', activeDownloadName: 'Batman: Ark-M #1' })];
            db.issues = [fileRow('1'), fileRow('1', { attachedVolumeId: 'av_sp', attachedVolume: lane, filePath: null })];

            await closeRequestsFulfilledBySeries('s_batman');

            expect(prisma.request.updateMany).not.toHaveBeenCalled();
        });

        it("never closes the run's request on the Special's #1", async () => {
            db.attachedVolumes = [arkM];
            db.requests = [requestRow('req_run', { issueNumber: '1', activeDownloadName: 'Batman #1' })];
            db.issues = [fileRow('1', { attachedVolumeId: 'av_sp', attachedVolume: lane })];

            await closeRequestsFulfilledBySeries('s_batman');

            expect(prisma.request.updateMany).not.toHaveBeenCalled();
        });
    });

    it("never closes a request for an attached volume on the run's issue of the same number", async () => {
        db.attachedVolumes = [{ id: 'av_annual', seriesId: 's_batman', metadataSource: 'COMICVINE', volumeId: '5555', kind: 'ANNUAL', name: 'Batman Annual' }];
        db.requests = [requestRow('req_annual', { volumeId: '5555', issueNumber: '1', activeDownloadName: 'Batman Annual #1' })];
        db.issues = [fileRow('1')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(prisma.request.updateMany).not.toHaveBeenCalled();
    });

    it('leaves a request that moved on after it was read as it is', async () => {
        // Read as NOT_FOUND; cancelled by its requester before the close is written.
        db.requests = [requestRow('req_37', { status: 'CANCELLED' })];
        vi.mocked(prisma.request.findMany).mockResolvedValueOnce([requestRow('req_37')] as never);
        db.issues = [fileRow('37')];

        await closeRequestsFulfilledBySeries('s_batman');

        expect(db.requests[0].status).toBe('CANCELLED');
    });

    it('does nothing for a series that is gone', async () => {
        expect(await closeRequestsFulfilledBySeries('s_missing')).toBe(0);
        expect(prisma.request.findMany).not.toHaveBeenCalled();
    });

    // A request the match completes used to ring only the in-app bell: Discord, email, Pushover,
    // Telegram and Apprise heard nothing, while the importer alerts for every request it completes.
    describe('the "available" alert', () => {
        const onDisk = (...numbers: string[]) => { db.issues = numbers.map(n => fileRow(n)); };

        it('tells the requester their issue is in the library', async () => {
            db.requests = [requestRow('req_37', { status: 'DOWNLOADING', activeDownloadName: 'Batman #31-40 (2016)', imageUrl: 'http://cover/37.jpg' })];
            onDisk('37');

            await closeRequestsFulfilledBySeries('s_batman');

            expect(notifierSendAlert).toHaveBeenCalledTimes(1);
            expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
                title: 'Batman #37',
                user: 'nicolas',
                email: 'n@example.test',
                imageUrl: 'http://cover/37.jpg',
                publisher: 'DC Comics',
                year: '2016',
                description: 'Matched in the Smart Matcher - #37 is in your library and ready to read.',
            }));
        });

        it('sends one alert for several issues of the same requester, listing them', async () => {
            db.requests = [
                requestRow('req_38', { status: 'PENDING', issueNumber: '38', activeDownloadName: 'Batman #38' }),
                requestRow('req_36', { status: 'NEEDS_REVIEW', issueNumber: '36', activeDownloadName: 'Batman #31-40 (2016)' }),
                requestRow('req_37', { status: 'MANUAL_DDL' }),
            ];
            onDisk('36', '37', '38');

            await closeRequestsFulfilledBySeries('s_batman');

            expect(notifierSendAlert).toHaveBeenCalledTimes(1);
            const [, payload] = notifierSendAlert.mock.calls[0] as [string, { title: string; description: string; email: string }];
            expect(payload.title).toBe('Batman - 3 Issues Available!');
            expect(payload.description).toBe('Matched in the Smart Matcher - #36, #37, #38 are in your library and ready to read.');
            expect(payload.email).toBe('n@example.test');
        });

        it('tells each requester about their own issues', async () => {
            db.requests = [
                requestRow('req_37', { status: 'DOWNLOADING' }),
                requestRow('req_38', { status: 'PENDING', issueNumber: '38', activeDownloadName: 'Batman #38', ...adam }),
            ];
            onDisk('37', '38');

            await closeRequestsFulfilledBySeries('s_batman');

            expect(notifierSendAlert).toHaveBeenCalledTimes(2);
            expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({ title: 'Batman #37', user: 'nicolas', email: 'n@example.test' }));
            expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({ title: 'Batman #38', user: 'adam', email: 'a@example.test' }));
        });

        it("never fails the close when an alert can't be sent", async () => {
            notifierSendAlert.mockRejectedValueOnce(new Error('Discord webhook 500'));
            db.requests = [requestRow('req_37', { status: 'DOWNLOADING' })];
            onDisk('37');

            expect(await closeRequestsFulfilledBySeries('s_batman')).toBe(1);
            await new Promise(r => setTimeout(r, 0)); // let the detached rejection reach its catch
            expect(closedIds()).toEqual(['req_37']);
        });
    });
});

describe('closeFulfilledParkedRequests (the Series Monitor)', () => {
    it('closes parked, unreleased and unapproved requests whose issue is in the library, leaving searches and downloads in flight alone', async () => {
        db.requests = ['NOT_FOUND', 'AWAITING_RELEASE', 'MANUAL_DDL', 'STALLED', 'NEEDS_REVIEW', 'UNRELEASED', 'PENDING_APPROVAL', 'PENDING', 'DOWNLOADING', 'IMPORTING']
            .map(status => requestRow(`req_${status}`, { status }));
        db.issues = [fileRow('37')];

        expect(await closeFulfilledParkedRequests()).toBe(7);

        expect(closedIds()).toEqual(['req_AWAITING_RELEASE', 'req_MANUAL_DDL', 'req_NEEDS_REVIEW', 'req_NOT_FOUND', 'req_PENDING_APPROVAL', 'req_STALLED', 'req_UNRELEASED']);
    });

    it('never closes a request made against the other provider that only shares the id', async () => {
        db.requests = [requestRow('req_metron', { metadataSource: 'METRON' })];
        db.issues = [fileRow('37')];

        expect(await closeFulfilledParkedRequests()).toBe(0);
    });

    it('leaves a request with no series id alone (the Smart Matcher will offer those)', async () => {
        db.series = [seriesRow({ id: '0' })];
        db.requests = [requestRow('req_title', { volumeId: '0' })];
        db.issues = [fileRow('37', { seriesId: '0' })];

        expect(await closeFulfilledParkedRequests()).toBe(0);
    });

    it('sends each requester one alert for the run, naming every issue', async () => {
        db.series = [seriesRow(), seriesRow({ id: 's_saga', name: 'Saga', publisher: 'Image', year: 2012, metadataId: '4321' })];
        db.requests = [
            requestRow('req_37'),
            requestRow('req_61', { volumeId: '4321', issueNumber: '61', activeDownloadName: 'Saga #61' }),
            requestRow('req_38', { issueNumber: '38', activeDownloadName: 'Batman #38', ...adam }),
        ];
        db.issues = [fileRow('37'), fileRow('38'), fileRow('61', { seriesId: 's_saga' })];

        await closeFulfilledParkedRequests();

        expect(notifierSendAlert).toHaveBeenCalledTimes(2);
        expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            user: 'nicolas',
            title: '2 Requested Issues Available!',
            description: 'Batman #37, Saga #61 are in your library and ready to read.',
        }));
        expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            user: 'adam',
            title: 'Batman #38',
            description: '#38 is in your library and ready to read.',
        }));
    });
});

// beta.010: what the rule can't tie to a series (a MyAnimeList import, a request against the other
// provider, a trade) an admin closes from Request Management - and the requester hears about it,
// which deleting the request never told them.
describe('markRequestsCompleted (Request Management)', () => {
    const asked = (...statuses: string[]) => statuses.map(status => requestRow(`req_${status}`, { status }));

    it('closes every open request it is given but a running download or an import, in the admin\'s name', async () => {
        db.requests = asked('NOT_FOUND', 'AWAITING_RELEASE', 'STALLED', 'UNRELEASED', 'PENDING_APPROVAL', 'PENDING', 'MANUAL_DDL', 'NEEDS_REVIEW', 'FAILED', 'ERROR',
            'DOWNLOADING', 'IMPORTING', 'COMPLETED', 'CANCELLED');
        const ids = db.requests.map(r => r.id as string);

        const result = await markRequestsCompleted([...ids, 'req_gone'], { notify: true, by: 'adam' });

        const open = ['NOT_FOUND', 'AWAITING_RELEASE', 'STALLED', 'UNRELEASED', 'PENDING_APPROVAL', 'PENDING', 'MANUAL_DDL', 'NEEDS_REVIEW', 'FAILED', 'ERROR'];
        expect(result.completed.map(r => r.id).sort()).toEqual(open.map(s => `req_${s}`).sort());
        expect(result.skipped.sort()).toEqual(['req_CANCELLED', 'req_COMPLETED', 'req_DOWNLOADING', 'req_IMPORTING', 'req_gone']);
        expect(prisma.request.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: { status: 'COMPLETED', progress: 100, notified: false, statusNote: 'Marked completed by adam' },
        }));
        expect(db.requests.find(r => r.id === 'req_DOWNLOADING')?.status).toBe('DOWNLOADING');
    });

    it("tells each requester once, by the request's own name", async () => {
        db.requests = [
            requestRow('req_naruto', { volumeId: '0', issueNumber: null, activeDownloadName: 'Naruto' }),
            requestRow('req_owls', { issueNumber: '1', activeDownloadName: 'Batman: The Court of Owls', ...adam }),
            requestRow('req_saga', { volumeId: '0', issueNumber: null, activeDownloadName: 'Saga #61' }),
        ];

        await markRequestsCompleted(['req_naruto', 'req_owls', 'req_saga'], { notify: true, by: 'adam' });

        expect(notifierSendAlert).toHaveBeenCalledTimes(2);
        expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            user: 'adam',
            title: 'Batman: The Court of Owls',
            description: 'Batman: The Court of Owls is in your library and ready to read.',
        }));
        expect(notifierSendAlert).toHaveBeenCalledWith('comic_available', expect.objectContaining({
            user: 'nicolas',
            title: '2 Requested Issues Available!',
            description: 'Naruto, Saga #61 are in your library and ready to read.',
        }));
    });

    it('closes quietly when the admin says not to tell the requester', async () => {
        db.requests = [requestRow('req_37')];

        await markRequestsCompleted(['req_37'], { notify: false, by: 'adam' });

        // Already told, as far as the bell is concerned.
        expect(db.requests[0]).toMatchObject({ status: 'COMPLETED', notified: true });
        expect(notifierSendAlert).not.toHaveBeenCalled();
    });

    it('leaves a request that moved on after it was read as it is', async () => {
        db.requests = [requestRow('req_37', { status: 'DOWNLOADING' })];
        vi.mocked(prisma.request.findMany).mockResolvedValueOnce([requestRow('req_37')] as never);

        await markRequestsCompleted(['req_37'], { notify: true, by: 'adam' });

        expect(db.requests[0].status).toBe('DOWNLOADING');
    });

    it('does nothing when none of them is open', async () => {
        db.requests = asked('COMPLETED');

        expect(await markRequestsCompleted(['req_COMPLETED'], { notify: true, by: 'adam' })).toEqual({ completed: [], skipped: ['req_COMPLETED'] });
        expect(prisma.request.updateMany).not.toHaveBeenCalled();
    });
});
