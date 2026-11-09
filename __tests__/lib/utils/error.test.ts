// __tests__/lib/utils/error.test.ts
//
// What a catch block may read off a thrown value of unknown type. getErrorMessage turns anything into
// a message; the other three answer exactly what the old `catch (e: any)` reads answered - so a
// catch that says `e?.message || 'Scan failed.'` keeps saying "Scan failed." for a thrown value with
// no message, and a status/code check stays false for anything that isn't the shape it looks for.
import { describe, it, expect } from 'vitest';
import { getErrorMessage, errorMessageOr, errorResponseStatus, errorCode } from '@/lib/utils/error';

class HttpError extends Error {
    constructor(message: string, public response?: { status?: unknown }) { super(message); }
}

describe('getErrorMessage', () => {
    it('reads an Error, a string, and a message-bearing object', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
        expect(getErrorMessage('plain text')).toBe('plain text');
        expect(getErrorMessage({ message: 'from an object' })).toBe('from an object');
    });

    it('answers a generic message for anything else', () => {
        expect(getErrorMessage(undefined)).toBe('An unknown error occurred');
        expect(getErrorMessage(42)).toBe('An unknown error occurred');
    });
});

describe('errorMessageOr', () => {
    it("is the thrown value's own message when it has one", () => {
        expect(errorMessageOr(new Error('boom'), 'Scan failed.')).toBe('boom');
        expect(errorMessageOr({ message: 'from an object' }, 'Scan failed.')).toBe('from an object');
    });

    it('is the fallback for an empty message, a value with no message, or nothing at all', () => {
        expect(errorMessageOr(new Error(''), 'Scan failed.')).toBe('Scan failed.');
        // `'text'?.message` is undefined, so the old `e?.message || fallback` fell back for strings too.
        expect(errorMessageOr('plain text', 'Scan failed.')).toBe('Scan failed.');
        expect(errorMessageOr({ message: 7 }, 'Scan failed.')).toBe('Scan failed.');
        expect(errorMessageOr(null, 'Scan failed.')).toBe('Scan failed.');
        expect(errorMessageOr(undefined, '')).toBe('');
    });
});

describe('errorResponseStatus', () => {
    it("reads an HTTP error's response status (where axios puts it)", () => {
        expect(errorResponseStatus(new HttpError('nope', { status: 429 }))).toBe(429);
        expect(errorResponseStatus({ response: { status: 401 } })).toBe(401);
    });

    it('is undefined without a numeric response status', () => {
        expect(errorResponseStatus(new Error('network down'))).toBeUndefined();
        expect(errorResponseStatus(new HttpError('nope', {}))).toBeUndefined();
        expect(errorResponseStatus({ response: { status: '429' } })).toBeUndefined();
        expect(errorResponseStatus(null)).toBeUndefined();
        expect(errorResponseStatus('429')).toBeUndefined();
    });
});

describe('errorCode', () => {
    it("reads a Node or Prisma error's code", () => {
        expect(errorCode(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('ENOENT');
        expect(errorCode({ code: 'P2002' })).toBe('P2002');
    });

    it('is undefined without a string code', () => {
        expect(errorCode(new Error('plain'))).toBeUndefined();
        expect(errorCode({ code: 2 })).toBeUndefined();
        expect(errorCode(undefined)).toBeUndefined();
    });
});
