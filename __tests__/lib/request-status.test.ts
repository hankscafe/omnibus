// One place that says what each stored Request.status means to a person (My Requests, Request
// Management and the profile used to each hard-code their own labels, and Request Management printed
// AWAITING_RELEASE / MANUAL_DDL raw). AWAITING_RELEASE also meant two different things: "searched every
// source, nothing yet" is NOT_FOUND now, and AWAITING_RELEASE is left for a released issue the monitor
// parked because it has no release date.
import { describe, it, expect } from 'vitest';
import {
    requestStatusLabel, requestStatusDetail, requestStatusClass, requestStatusMatches,
    WAITING_STATUSES, CANCELLABLE_STATUSES, REQUEST_STATUS_FILTERS,
} from '@/lib/request-status';

const KNOWN = ['PENDING_APPROVAL', 'PENDING', 'DOWNLOADING', 'MANUAL_DDL', 'IMPORTING', 'IMPORTED', 'COMPLETED', 'UNRELEASED',
    'AWAITING_RELEASE', 'NOT_FOUND', 'STALLED', 'FAILED', 'ERROR', 'NEEDS_REVIEW', 'CANCELLED'];

describe('request status labels', () => {
    it('says what each stored status means', () => {
        expect(requestStatusLabel('NOT_FOUND')).toBe('Not Found Yet');
        expect(requestStatusLabel('AWAITING_RELEASE')).toBe('Awaiting Date');
        expect(requestStatusLabel('MANUAL_DDL')).toBe('GetComics Link');
        expect(requestStatusLabel('PENDING_APPROVAL')).toBe('Needs Approval');
        expect(requestStatusLabel('IMPORTING')).toBe('Importing…');
        expect(requestStatusLabel('NEEDS_REVIEW')).toBe('Needs Review');
        expect(requestStatusLabel('IMPORTED')).toBe('Completed');
        expect(requestStatusLabel('COMPLETED')).toBe('Completed');
        expect(requestStatusLabel('STALLED')).toBe('Stalled');
        expect(requestStatusLabel('PENDING')).toBe('Pending');
        expect(requestStatusLabel('CANCELLED')).toBe('Cancelled');
    });

    it('never shows a stored status name for a status it knows', () => {
        for (const status of KNOWN) {
            expect(requestStatusLabel(status)).not.toMatch(/_|^[A-Z]+$/);
        }
    });

    it('falls back to the stored value for a status it does not know', () => {
        expect(requestStatusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    });

    it('explains the two waiting states differently', () => {
        expect(requestStatusDetail('NOT_FOUND')).toMatch(/not on any source yet/i);
        expect(requestStatusDetail('AWAITING_RELEASE')).toMatch(/release date/i);
        for (const status of ['NOT_FOUND', 'AWAITING_RELEASE']) expect(requestStatusDetail(status)).toMatch(/automatically/i);
        expect(requestStatusDetail('DOWNLOADING')).toBeNull();
    });

    it('colours both waiting states as information, not as a failure', () => {
        expect(requestStatusClass('NOT_FOUND')).toBe(requestStatusClass('AWAITING_RELEASE'));
        expect(requestStatusClass('NOT_FOUND')).toContain('sky');
        expect(requestStatusClass('STALLED')).toContain('red');
        expect(requestStatusClass('SOMETHING_NEW')).toContain('bg-muted');
    });

    it('groups the waiting states, and a requester may cancel either', () => {
        expect([...WAITING_STATUSES].sort()).toEqual(['AWAITING_RELEASE', 'NOT_FOUND']);
        for (const status of WAITING_STATUSES) expect(CANCELLABLE_STATUSES).toContain(status);
        for (const status of ['STALLED', 'COMPLETED', 'IMPORTING', 'CANCELLED']) expect(CANCELLABLE_STATUSES).not.toContain(status);
    });

    it('a filter matches every status that reads the same, and nothing else', () => {
        expect(requestStatusMatches('COMPLETED', 'IMPORTED')).toBe(true);
        expect(requestStatusMatches('IMPORTED', 'IMPORTED')).toBe(true);
        expect(requestStatusMatches('NOT_FOUND', 'AWAITING_RELEASE')).toBe(false);
        expect(requestStatusMatches('NOT_FOUND', 'NOT_FOUND')).toBe(true);
        expect(requestStatusMatches('STALLED', 'ALL')).toBe(true);
    });

    it("offers Request Management a filter for every status it can show, with the same labels", () => {
        const values = REQUEST_STATUS_FILTERS.map(f => f.value);
        for (const status of ['NOT_FOUND', 'AWAITING_RELEASE', 'MANUAL_DDL', 'UNRELEASED', 'STALLED', 'IMPORTING', 'NEEDS_REVIEW', 'PENDING_APPROVAL']) {
            expect(values).toContain(status);
        }
        for (const f of REQUEST_STATUS_FILTERS) expect(f.label).toBe(requestStatusLabel(f.value));
    });
});
