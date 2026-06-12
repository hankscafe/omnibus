// src/lib/utils/safe-parse.ts

/** Parses a JSON string expected to contain an array; returns [] on any failure and drops "NONE" placeholders. */
export const safeParse = (str: string | null): any[] => {
    if (!str) return [];
    try {
        const arr = JSON.parse(str);
        return Array.isArray(arr) ? arr.filter((item: string) => item !== "NONE") : [];
    } catch { return []; }
};
