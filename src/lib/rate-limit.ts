// src/lib/rate-limit.ts
import { NextResponse } from "next/server";
import { Logger } from "./logger";

const trackers = new Map<string, { count: number, lockoutUntil: number }>();

export function checkRateLimit(identifier: string, limit: number = 5, windowMs: number = 15 * 60 * 1000) {
    const data = trackers.get(identifier) || { count: 0, lockoutUntil: 0 };
    
    if (Date.now() < data.lockoutUntil) {
        const remaining = Math.ceil((data.lockoutUntil - Date.now()) / 60000);
        Logger.log(`[Rate Limit Debug] Blocked request for identifier: ${identifier}. Locked out for ${remaining}m.`, 'debug');
        return { 
            isLimited: true, 
            message: `Too many attempts. Try again in ${remaining} minutes.`,
            response: NextResponse.json({ error: `Locked out for ${remaining}m.` }, { status: 429 }),
            // Provide dummy functions to satisfy TypeScript's strict type checking
            trackFailure: () => {},
            trackSuccess: () => {}
        };
    }

    return {
        isLimited: false,
        message: "",
        response: null,
        trackFailure: () => {
            data.count += 1;
            Logger.log(`[Rate Limit Debug] Tracked failure for identifier: ${identifier} (Attempt ${data.count}/${limit})`, 'debug');
            if (data.count >= limit) {
                Logger.log(`[Rate Limit Debug] Identifier ${identifier} exceeded limit! Initiating ${Math.round(windowMs / 60000)}m lockout.`, 'debug');
                data.lockoutUntil = Date.now() + windowMs;
            }
            trackers.set(identifier, data);
        },
        trackSuccess: () => trackers.delete(identifier)
    };
}