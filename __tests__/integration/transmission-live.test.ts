// @vitest-environment node
//
// OPT-IN live-contract test for the Transmission RPC integration. It uses a unique paused
// magnet, so the daemon never downloads payload data; the torrent is removed in finally.
//
// Example with a pinned Transmission daemon:
//   docker run -d --name transmission-live -p 9091:9091 \
//     -e USER=omnibus -e PASS=omnibus-test lscr.io/linuxserver/transmission:4.0.6
//   TRANSMISSION_LIVE_URL=http://localhost:9091 \
//     TRANSMISSION_LIVE_USER=omnibus TRANSMISSION_LIVE_PASS=omnibus-test \
//     npx vitest run __tests__/integration/transmission-live.test.ts
//
// Set only TRANSMISSION_LIVE_URL when RPC authentication is disabled. The test is skipped
// entirely when that variable is unset, so the normal CI suite never needs a daemon.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTransmissionRpc } from '@/lib/transmission';

const url = process.env.TRANSMISSION_LIVE_URL;

(url ? describe : describe.skip)('LIVE: Transmission RPC against a real daemon', () => {
    it('adds, lists, updates, and removes a paused torrent', async () => {
        const rpc = createTransmissionRpc({
            url: url!,
            user: process.env.TRANSMISSION_LIVE_USER,
            pass: process.env.TRANSMISSION_LIVE_PASS,
        }, { 'User-Agent': 'Omnibus/1.0' }, 10000);

        let torrentHash: string | undefined;
        try {
            const session = await rpc('session_get');
            expect(session.version).toMatch(/^\d/);
            expect(Number(session.rpc_version)).toBeGreaterThan(0);

            const magnetHash = randomBytes(20).toString('hex');
            const label = `omnibus-live-${magnetHash.slice(0, 8)}`;
            const addParams: Record<string, unknown> = {
                filename: `magnet:?xt=urn:btih:${magnetHash}&dn=Omnibus+Transmission+Live+Test`,
                paused: true,
            };
            if (Number(session.rpc_version) >= 17) addParams.labels = [label];

            const addResult = await rpc('torrent_add', addParams);
            const addedTorrent = addResult.torrent_added || addResult.torrent_duplicate;
            torrentHash = addedTorrent?.hash_string;
            expect(torrentHash?.toLowerCase()).toBe(magnetHash);

            if (Number(session.rpc_version) >= 16 && Number(session.rpc_version) < 17) {
                await rpc('torrent_set', { ids: [torrentHash], labels: [label] });
            }
            await rpc('torrent_set', {
                ids: [torrentHash],
                seed_ratio_limit: 1.5,
                seed_ratio_mode: 1,
            });

            const fields = ['id', 'name', 'hash_string', 'status', 'seed_ratio_limit', 'seed_ratio_mode'];
            if (Number(session.rpc_version) >= 16) fields.push('labels');
            const listResult = await rpc('torrent_get', { ids: [torrentHash], fields });
            const torrent = listResult.torrents?.[0];
            expect(torrent).toBeDefined();
            expect(torrent?.hash_string?.toLowerCase()).toBe(magnetHash);
            expect(torrent?.status).toBe(0);
            expect(torrent?.seed_ratio_limit).toBe(1.5);
            expect(torrent?.seed_ratio_mode).toBe(1);
            if (Number(session.rpc_version) >= 16) expect(torrent?.labels).toContain(label);

            await rpc('torrent_remove', { ids: [torrentHash], delete_local_data: true });
            torrentHash = undefined;

            const afterRemoval = await rpc('torrent_get', { ids: [magnetHash], fields: ['id', 'hash_string'] });
            expect(afterRemoval.torrents).toHaveLength(0);
        } finally {
            if (torrentHash) {
                await rpc('torrent_remove', { ids: [torrentHash], delete_local_data: true }).catch(() => undefined);
            }
        }
    });
});