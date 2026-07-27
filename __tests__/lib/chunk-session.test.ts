// Chunked-upload session accounting (field bug 2026-07-27, NAS-backed drop folder): the route
// verified chunk offsets against bare fs.stat() of the .part — NFS attribute caches serve STALE
// sizes for seconds after another request's write, 409-ing healthy sessions with mid-write
// snapshot numbers ("expected offset 50331648, have 10483589"). The process's own append
// accounting is now the source of truth; the filesystem is consulted only when the process has
// no memory of the session (restart mid-upload), with one grace retry for laggy caches; and the
// assembled file's size is verified before it can be renamed into the watched folder.
import { describe, it, expect, vi } from 'vitest';
import {
    noteChunkAppended, sessionBytes, dropSession, sweepSessions,
    verifyChunkOffset, verifyAssembledSize,
} from '@/lib/uploads/chunk-session';

const CHUNK = 48 * 1024 * 1024;

describe('verifyChunkOffset (NAS stale-stat hardening)', () => {
    it('trusts the in-process session and never probes the filesystem when it matches', async () => {
        const probe = vi.fn();
        const v = await verifyChunkOffset({ chunkOffset: CHUNK, sessionTotal: CHUNK, probe });
        expect(v).toEqual({ ok: true });
        expect(probe).not.toHaveBeenCalled();
    });

    it('rejects on a true session mismatch without touching the filesystem', async () => {
        const probe = vi.fn();
        const v = await verifyChunkOffset({ chunkOffset: CHUNK * 2, sessionTotal: CHUNK, probe });
        expect(v).toEqual({ ok: false, have: CHUNK });
        expect(probe).not.toHaveBeenCalled();
    });

    it('falls back to the probe when the process has no session (server restarted)', async () => {
        const probe = vi.fn().mockResolvedValue(CHUNK);
        const v = await verifyChunkOffset({ chunkOffset: CHUNK, sessionTotal: undefined, probe });
        expect(v).toEqual({ ok: true });
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('re-probes once after a grace delay when the first read looks stale', async () => {
        const probe = vi.fn().mockResolvedValueOnce(10483589).mockResolvedValueOnce(CHUNK);
        const v = await verifyChunkOffset({ chunkOffset: CHUNK, sessionTotal: undefined, probe, delayMs: 1 });
        expect(v).toEqual({ ok: true });
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('fails with the observed size when both probes disagree, and with "no session" when the file is gone', async () => {
        const stale = vi.fn().mockResolvedValue(10483589);
        expect(await verifyChunkOffset({ chunkOffset: CHUNK, sessionTotal: undefined, probe: stale, delayMs: 1 }))
            .toEqual({ ok: false, have: 10483589 });
        const missing = vi.fn().mockResolvedValue(null);
        expect(await verifyChunkOffset({ chunkOffset: CHUNK, sessionTotal: undefined, probe: missing, delayMs: 1 }))
            .toEqual({ ok: false, have: 'no session' });
    });
});

describe('verifyAssembledSize (no corrupt file ever renames into the library)', () => {
    it('accepts when the on-disk size matches the accumulated total', async () => {
        const probe = vi.fn().mockResolvedValue(CHUNK + 10483589);
        expect(await verifyAssembledSize(CHUNK + 10483589, probe, 1)).toEqual({ ok: true });
    });

    it('retries once for a stale read, then accepts', async () => {
        const probe = vi.fn().mockResolvedValueOnce(10483589).mockResolvedValueOnce(CHUNK + 10483589);
        expect(await verifyAssembledSize(CHUNK + 10483589, probe, 1)).toEqual({ ok: true });
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('rejects with the observed size when the storage genuinely lost bytes', async () => {
        const probe = vi.fn().mockResolvedValue(10483589);
        expect(await verifyAssembledSize(CHUNK + 10483589, probe, 1)).toEqual({ ok: false, have: 10483589 });
    });
});

describe('session store', () => {
    it('round-trips, drops, and sweeps by age', () => {
        noteChunkAppended('upload-a', CHUNK);
        expect(sessionBytes('upload-a')).toBe(CHUNK);
        noteChunkAppended('upload-a', CHUNK * 2);
        expect(sessionBytes('upload-a')).toBe(CHUNK * 2);
        dropSession('upload-a');
        expect(sessionBytes('upload-a')).toBeUndefined();

        noteChunkAppended('upload-old', CHUNK);
        noteChunkAppended('upload-new', CHUNK);
        sweepSessions(Date.now() + 60_000); // cutoff in the future: everything is "old"
        expect(sessionBytes('upload-old')).toBeUndefined();
        expect(sessionBytes('upload-new')).toBeUndefined();

        noteChunkAppended('upload-fresh', CHUNK);
        sweepSessions(Date.now() - 60_000); // cutoff in the past: fresh survives
        expect(sessionBytes('upload-fresh')).toBe(CHUNK);
        dropSession('upload-fresh');
    });
});
