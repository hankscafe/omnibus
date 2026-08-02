// __tests__/helpers/request.ts
//
// Request builders (beta.014 test refactor) — replaces ~26 per-file `createReq` definitions.
// Bind the URL once per file so call sites stay `createReq(body)`:
//   const createReq = makePostJson('http://localhost/api/library/update');
// Files that need special headers pass them at bind time; genuinely bespoke builders (mutating
// x-forwarded-for counters, cookies) stay local to their file.
import { NextRequest } from 'next/server';

export const makePostJson = (url: string, extraHeaders: Record<string, string> = {}) =>
    (body: any) => new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
    });

export const makeNextPostJson = (url: string, extraHeaders: Record<string, string> = {}) =>
    (body: any) => new NextRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
    });

export const getReq = (url: string) => new Request(url);

/** Next 15 async route params: routes receive `{ params: Promise<...> }`. */
export const asyncParams = <T,>(params: T): Promise<T> => Promise.resolve(params);
