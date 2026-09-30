// __tests__/api/reading-list-autobuild.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/auto-build/route';
import axios from 'axios';
import { makePostJson } from '../helpers/request';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findUniqueSetting: vi.fn(),
    findFirstIssue: vi.fn(),
    createList: vi.fn(),
    createListItems: vi.fn(),
    log: vi.fn(),
    getMetronAuth: vi.fn(),
    metronGet: vi.fn()
}));

// Metron traffic goes through the shared client (its pacing / auth / retries have their own tests in
// __tests__/lib/metron-client.test.ts); here it is the boundary.
vi.mock('@/lib/metron/client', () => ({ getMetronAuth: mocks.getMetronAuth, metronGet: mocks.metronGet }));

// 2. Mock Dependencies
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.findUniqueSetting },
        issue: { findFirst: mocks.findFirstIssue },
        readingList: { create: mocks.createList },
        readingListItem: { createMany: mocks.createListItems }
    }
}));


// Mock Axios for both ComicVine and Metron
vi.mock('axios');
// The CV path fetches through the pooled apiClient (via cachedCvGet) — alias it to the same
// automocked axios.get so the per-test mockResolvedValueOnce queues serve both clients.
vi.mock('@/lib/api-client', async () => {
    const axios = (await import('axios')).default;
    return { apiClient: { get: axios.get } };
});

const createReq = makePostJson('http://localhost/api/reading-lists/auto-build');

describe('Data Processing: Reading List Auto-Builder', () => {
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        
        // Bypass rate limit delays
        originalSetTimeout = global.setTimeout;
        vi.stubGlobal('setTimeout', (cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0));
        
        mocks.createList.mockResolvedValue({ id: 'list_123' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should successfully build a list from ComicVine data', async () => {
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'cv_key' });
        
        // Simulate CV returning a Story Arc with 2 issues
        vi.mocked(axios.get).mockResolvedValueOnce({
            data: {
                results: {
                    name: 'Secret Wars',
                    description: 'A massive crossover.',
                    issues: [
                        { id: '100', issue_number: '1', name: 'The End' },
                        { id: '101', issue_number: '2', name: 'Battleworld' }
                    ]
                }
            }
        } as any);

        // Simulate local DB finding a match for the first issue, but NOT the second
        mocks.findFirstIssue.mockResolvedValueOnce({ id: 'local_issue_1', filePath: '/comics/SecretWars1.cbz' });
        mocks.findFirstIssue.mockResolvedValueOnce(null);

        const res = await POST(createReq({ eventId: '40978', eventSource: 'COMICVINE' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);

        // Verify the database writes occurred
        expect(mocks.createList).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ name: 'Secret Wars' })
        }));
        
        expect(mocks.createListItems).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.arrayContaining([
                // Issue 1 should have a linked local ID
                expect.objectContaining({ issueId: 'local_issue_1', cvIssueId: 100, metadataSource: 'COMICVINE' }),
                // Issue 2 should have a null local ID (Missing!)
                expect.objectContaining({ issueId: null, cvIssueId: 101, metadataSource: 'COMICVINE' })
            ])
        }));
    });

    it('should successfully paginate and build a list from Metron data', async () => {
        // Configured Metron credentials
        mocks.getMetronAuth.mockResolvedValue({ kind: 'token', token: 'tok' });

        // 1st Fetch: Arc Details
        mocks.metronGet.mockResolvedValueOnce({ status: 200, cached: false, data: { name: 'Absolute Carnage', desc: 'Symbiote attack.' } });

        // 2nd Fetch: Issue List (Page 1) - Returns 1 issue and a "next" URL
        mocks.metronGet.mockResolvedValueOnce({ status: 200, cached: false, data: { next: 'page_2', results: [{ id: '200', number: '1', series: { name: 'Venom' } }] } });

        // 3rd Fetch: Issue List (Page 2) - Returns 1 issue and NO "next" URL
        mocks.metronGet.mockResolvedValueOnce({ status: 200, cached: false, data: { next: null, results: [{ id: '201', number: '2', series: { name: 'Venom' } }] } });

        mocks.findFirstIssue.mockResolvedValue(null); // No local matches

        const res = await POST(createReq({ eventId: '31', eventSource: 'METRON' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);

        // Every page went through the shared client, paced as interactive work (someone is waiting).
        expect(mocks.metronGet.mock.calls.map(c => c[0])).toEqual([
            'https://metron.cloud/api/arc/31/',
            'https://metron.cloud/api/arc/31/issue_list/',
            'page_2',
        ]);
        expect(mocks.metronGet.mock.calls.every(c => c[1].pace === 'interactive')).toBe(true);

        // Verify it traversed both pages and added 2 issues
        expect(mocks.createListItems).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.arrayContaining([
                expect.objectContaining({ title: 'Venom #1', metadataSource: 'METRON' }),
                expect.objectContaining({ title: 'Venom #2', metadataSource: 'METRON' })
            ])
        }));
    });
});