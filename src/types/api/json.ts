// src/types/api/json.ts
//
// What a route's reply looks like once it has been through JSON: a route holds Dates, the page
// receives ISO strings. Payload types in src/types/api describe what the ROUTE builds (so tsc checks
// the route); a page reads `Jsonified<ThatPayload>`.
export type Jsonified<T> =
    T extends Date ? string
    : T extends (infer U)[] ? Jsonified<U>[]
    : T extends object ? { [K in keyof T]: Jsonified<T[K]> }
    : T;
