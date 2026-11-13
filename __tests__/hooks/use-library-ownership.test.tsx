// @vitest-environment jsdom
// useLibraryOwnership (lint batch 3i, v1.4.11-beta.038): what Discover and the request search show for a
// volume or an issue - owned, covered, unreleased, or a request in flight (matched by volume and name, or
// by name alone, either case). The requests come from /api/library/ids, each named by its download.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';
import { useLibraryOwnership } from '@/hooks/use-library-ownership';

beforeEach(() => {
    stubFetchRouter([
        ['/api/library/ids', () => ok({
            series: [7, '300'], monitored: [7], issues: [1001], covered: [1002],
            requests: [
                { volumeId: '9', status: 'PENDING_APPROVAL', name: 'Saga #61' },
                { volumeId: '8', status: 'DOWNLOADING', name: 'Paper Girls #3 (2016) (digital)' },
                { volumeId: '8', status: 'IMPORTED', name: 'Paper Girls #2' },
            ],
        })],
    ]);
});

const loaded = async () => {
    const { result } = renderHook(() => useLibraryOwnership());
    await waitFor(() => expect(result.current.getVolumeStatus(7)).toBe('LIBRARY_MONITORED'));
    return result;
};

describe('useLibraryOwnership', () => {
    it('volumes: owned (monitored or not), a request in flight, nothing - and no id at all', async () => {
        const result = await loaded();
        expect(result.current.getVolumeStatus('300')).toBe('LIBRARY_UNMONITORED');
        expect(result.current.getVolumeStatus(9)).toBe('PENDING_APPROVAL');
        expect(result.current.getVolumeStatus('8')).toBe('REQUESTED');
        expect(result.current.getVolumeStatus(55)).toBe(null);
        expect(result.current.getVolumeStatus(null)).toBe(null);
    });

    it('issues: owned, covered, unreleased', async () => {
        const result = await loaded();
        expect(result.current.getIssueStatus(1001, 7, 'Owned #1')).toBe('ISSUE_OWNED');
        expect(result.current.getIssueStatus(1002, 7, 'Covered #2')).toBe('ISSUE_COVERED');
        expect(result.current.getIssueStatus(1003, 7, 'Future #9', false)).toBe('UNRELEASED');
        expect(result.current.getIssueStatus(1004, 7, 'Nothing #3', true)).toBe(null);
    });

    it('issues: a request in flight, by volume and name, by name alone in any case, or by "Series #N"', async () => {
        const result = await loaded();
        expect(result.current.getIssueStatus(5, 9, 'Saga #61')).toBe('PENDING_APPROVAL');
        expect(result.current.getIssueStatus(6, 99, 'SAGA #61')).toBe('PENDING_APPROVAL');
        expect(result.current.getIssueStatus(7, 8, 'paper girls #3 (2016) (digital)')).toBe('REQUESTED');
        expect(result.current.getIssueStatus(8, 8, 'Paper Girls #2')).toBe('ISSUE_OWNED');
        expect(result.current.getIssueStatus(9, null, 'Saga #61: A Title', true, '061', 'Saga')).toBe('PENDING_APPROVAL');
    });
});
