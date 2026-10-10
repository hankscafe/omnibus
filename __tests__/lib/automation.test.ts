// __tests__/lib/automation.test.ts
// automation.ts is now a thin layer: searchAndDownload() enqueues a BullMQ
// SEARCH_AND_DOWNLOAD job (the Rust engine performs the actual search via
// queue.ts -> /api/automation/search). The legacy full-Node search
// (executeSearchAndDownload) was deleted as dead code.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchAndDownload, processAutomationQueue } from '@/lib/automation';

const mocks = vi.hoisted(() => ({
    queueAdd: vi.fn().mockResolvedValue({}),
    queueGetJob: vi.fn().mockResolvedValue(undefined),
}));

// searchAndDownload pulls the queue in via a dynamic import; vi.mock covers that too.
vi.mock('@/lib/queue', () => ({
    omnibusQueue: { add: mocks.queueAdd, getJob: mocks.queueGetJob }
}));

describe('Core Logic: Automation (engine handoff)', () => {

    // #240: BullMQ ignores an add whose job id still exists - and it keeps finished jobs
    // (removeOnComplete: 100). Every search for a request uses the id SEARCH_<requestId>, so a
    // re-search after a failed or refused download was silently dropped while the old one was kept.
    describe('re-searching a request', () => {
        const previousJob = (state: string) => ({ getState: vi.fn().mockResolvedValue(state), remove: vi.fn().mockResolvedValue(undefined) });

        it('clears the request\'s finished search job first, so the new search is actually queued', async () => {
            for (const state of ['completed', 'failed']) {
                const old = previousJob(state);
                mocks.queueGetJob.mockResolvedValueOnce(old);
                await searchAndDownload('req_9', 'Batman', '2024');
                expect(mocks.queueGetJob).toHaveBeenLastCalledWith('SEARCH_req_9');
                expect(old.remove).toHaveBeenCalled();
                expect(old.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.queueAdd.mock.invocationCallOrder.at(-1)!);
            }
        });

        it('leaves a search that is still pending alone, so a request is never searched twice at once', async () => {
            for (const state of ['waiting', 'delayed', 'active', 'prioritized']) {
                const pending = previousJob(state);
                mocks.queueGetJob.mockResolvedValueOnce(pending);
                await searchAndDownload('req_9', 'Batman', '2024');
                expect(pending.remove).not.toHaveBeenCalled();
            }
        });

        it('still queues the search when the queue cannot be inspected', async () => {
            mocks.queueGetJob.mockRejectedValueOnce(new Error('redis down'));
            await searchAndDownload('req_10', 'Batman', '2024');
            expect(mocks.queueAdd).toHaveBeenLastCalledWith('SEARCH_AND_DOWNLOAD', expect.objectContaining({ requestId: 'req_10' }), expect.objectContaining({ jobId: 'SEARCH_req_10' }));
        });
    });

    describe('searchAndDownload()', () => {
        it('should enqueue a SEARCH_AND_DOWNLOAD job with the full request payload', async () => {
            await searchAndDownload('req_1', 'Batman', '2024', 'DC', false, true);

            expect(mocks.queueAdd).toHaveBeenCalledWith(
                'SEARCH_AND_DOWNLOAD',
                {
                    type: 'SEARCH_AND_DOWNLOAD',
                    requestId: 'req_1',
                    name: 'Batman',
                    year: '2024',
                    publisher: 'DC',
                    isManga: false,
                    skipIndexers: true
                },
                expect.objectContaining({ jobId: 'SEARCH_req_1' })
            );
        });

        it('should space successive searches apart via increasing enqueue delays', async () => {
            await searchAndDownload('req_a', 'Batman', '2024');
            await searchAndDownload('req_b', 'Superman', '2024');

            const delayA = mocks.queueAdd.mock.calls[0][2].delay;
            const delayB = mocks.queueAdd.mock.calls[1][2].delay;

            // Second job must be scheduled at least ~5s after the first
            expect(delayB - delayA).toBeGreaterThanOrEqual(4000);
        });
    });

    describe('processAutomationQueue()', () => {
        it('should enqueue one job per queued automation item', async () => {
            await processAutomationQueue([
                { id: 'req_1', name: 'Batman', year: '2024', publisher: 'DC', isManga: false, skipIndexers: false },
                { id: 'req_2', name: 'Akira', year: '1988', publisher: 'Kodansha', isManga: true, skipIndexers: false }
            ]);

            expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
            expect(mocks.queueAdd).toHaveBeenCalledWith(
                'SEARCH_AND_DOWNLOAD',
                expect.objectContaining({ requestId: 'req_2', name: 'Akira', isManga: true }),
                expect.objectContaining({ jobId: 'SEARCH_req_2' })
            );
        });
    });
});
