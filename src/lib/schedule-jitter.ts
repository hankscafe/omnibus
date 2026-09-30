// src/lib/schedule-jitter.ts
//
// Per-install schedule offsets (#216). BullMQ's legacy `repeat: { every }` lands on multiples of the
// interval since the Unix epoch, so every Omnibus install fired its daily jobs at 00:00 UTC together -
// a nightly burst against Metron. Each install now has a random seed (SystemSetting `schedule_seed`),
// and each scheduled job gets a stable offset inside its own interval derived from it: installs spread
// across the whole interval, one install's jobs don't start on the same second, and a restart keeps
// every job in the same slot.
import crypto from 'crypto';

export const SCHEDULE_SEED_KEY = 'schedule_seed';

/** A fresh random install seed (32 hex characters). */
export function newScheduleSeed(): string {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * This install's offset for `jobType` within an `everyMs` interval, in [1, everyMs). Never 0: BullMQ's
 * job scheduler treats a zero offset as "run now" on creation.
 */
export function scheduleOffsetMs(seed: string, jobType: string, everyMs: number): number {
    const digest = crypto.createHash('sha256').update(`${seed}:${jobType}`).digest();
    const fraction = digest.readUIntBE(0, 6) / 2 ** 48; // 48 bits → [0, 1)
    return 1 + Math.floor(fraction * (everyMs - 1));
}
