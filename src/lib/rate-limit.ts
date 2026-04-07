// src/lib/rate-limit.ts
import { NextResponse } from "next/server";

const trackers = new Map<string, { count: number, lockoutUntil: number }>();

export function checkRateLimit(identifier: string, limit: number = 5, windowMs: number = 15 * 60 * 1000) {
    const data = trackers.get(identifier) || { count: 0, lockoutUntil: 0 };
    
    if (Date.now() < data.lockoutUntil) {
        const remaining = Math.ceil((data.lockoutUntil - Date.now()) / 60000);
        return { 
            isLimited: true, 
            message: `Too many attempts. Try again in ${remaining} minutes.`,
            response: NextResponse.json({ error: `Locked out for ${remaining}m.` }, { status: 429 })
        };
    }

    return {
        isLimited: false,
        trackFailure: () => {
            data.count += 1;
            if (data.count >= limit) {
                data.lockoutUntil = Date.now() + windowMs;
            }
            trackers.set(identifier, data);
        },
        trackSuccess: () => trackers.delete(identifier)
    };
}