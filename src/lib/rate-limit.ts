// src/lib/rate-limit.ts
import { NextResponse } from "next/server";
import { Logger } from "./logger";

const trackers = new Map<string, { count: number, lockoutUntil: number }>();
const globalWindows = new Map<string, { count: number, windowStart: number }>();

/**
 * Best-effort client IP for per-IP rate limiting. Splits X-Forwarded-For and takes only the first
 * (origin-client) hop — using the raw comma-joined header as a key is both wrong behind a real proxy and
 * trivially unique-per-request. NOTE: in the shipped direct-exposure deployment XFF is client-controlled
 * and therefore spoofable, so the per-IP limit is best-effort only; checkGlobalRateLimit is the real
 * backstop against an attacker rotating the header.
 */
export function getClientIp(req: Request): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }
    const real = req.headers.get('x-real-ip');
    if (real && real.trim()) return real.trim();
    return 'unknown';
}

/**
 * Coarse, IP-independent backstop: caps total attempts for an action across ALL callers within a fixed
 * window, so spoofing/rotating X-Forwarded-For can't defeat the per-IP limit indefinitely. Fixed-window
 * (auto-resets after windowMs) so a maliciously-tripped cap self-clears within the window rather than
 * persisting. Limits are set generously enough that legitimate low-volume auth traffic never reaches them.
 */
export function checkGlobalRateLimit(action: string, limit: number, windowMs: number) {
    const now = Date.now();
    const w = globalWindows.get(action);
    if (!w || now - w.windowStart > windowMs) {
        globalWindows.set(action, { count: 1, windowStart: now });
        return { isLimited: false, response: null as NextResponse | null };
    }
    w.count += 1;
    if (w.count > limit) {
        return {
            isLimited: true,
            response: NextResponse.json({ error: "Service is temporarily busy. Please try again in a few minutes." }, { status: 429 }) as NextResponse | null,
        };
    }
    return { isLimited: false, response: null as NextResponse | null };
}

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