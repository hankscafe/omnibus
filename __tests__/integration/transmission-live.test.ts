// @vitest-environment node
// OPT-IN: npm run test:transmission starts an authenticated disposable Docker daemon.
// TRANSMISSION_LIVE_URL (with optional USER/PASS variables) uses an existing daemon instead.
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTransmissionRpc, getTransmissionTorrents, mapTransmissionDownloads } from '@/lib/transmission';

const docker = promisify(execFile);
const useDocker = process.env.TRANSMISSION_LIVE_DOCKER === '1';
let url = process.env.TRANSMISSION_LIVE_URL;
let user = process.env.TRANSMISSION_LIVE_USER;
let pass = process.env.TRANSMISSION_LIVE_PASS;
let containerName: string | undefined;

(url || useDocker ? describe : describe.skip)('LIVE: Transmission RPC against a real daemon', () => {
    beforeAll(async () => {
        if (url) return;

        containerName = `omnibus-transmission-${randomBytes(8).toString('hex')}`;
        user = 'omnibus';
        pass = randomBytes(24).toString('hex');
        await docker('docker', [
            'run', '--detach', '--rm', '--name', containerName,
            '--publish', '127.0.0.1::9091',
            '--env', `USER=${user}`, '--env', `PASS=${pass}`,
            '--env', 'WHITELIST=*', '--env', 'HOST_WHITELIST=localhost,127.0.0.1',
            process.env.TRANSMISSION_LIVE_IMAGE || 'lscr.io/linuxserver/transmission:4.1.4-r0-ls367',
        ], { timeout: 240000 });
        const { stdout } = await docker('docker', ['port', containerName, '9091/tcp'], { timeout: 10000 });
        const port = Number(stdout.trim().split(':').at(-1));
        expect(port).toBeGreaterThan(0);
        url = `http://127.0.0.1:${port}`;

        const rpc = createTransmissionRpc({ url, user, pass }, {}, 2000);
        try {
            await vi.waitFor(async () => {
                const session = await rpc('session_get');
                expect(session.version).toMatch(/^\d/);
            }, { timeout: 60000, interval: 500 });
        } catch (error) {
            const { stdout, stderr } = await docker('docker', ['logs', containerName], { timeout: 10000 });
            throw new Error(`Transmission did not become ready: ${stdout}${stderr}`, { cause: error });
        }
    }, 310000);

    afterAll(async () => {
        if (containerName) {
            await docker('docker', ['rm', '--force', '--volumes', containerName], { timeout: 30000 });
        }
    }, 35000);

    it('adds, lists, updates, and removes a paused torrent', async () => {
        const rpc = createTransmissionRpc({
            url: url!,
            user,
            pass,
        }, { 'User-Agent': 'Omnibus/1.0' }, 10000);

        let torrentHash: string | undefined;
        try {
            const session = await rpc('session_get');
            expect(session.version).toMatch(/^\d/);
            expect(Number(session.rpc_version)).toBeGreaterThan(0);
            console.info(`Transmission live test: version ${session.version}, RPC ${session.rpc_version}`);

            const magnetHash = randomBytes(20).toString('hex');
            const label = `omnibus-live-${magnetHash.slice(0, 8)}`;
            const addParams: Record<string, unknown> = {
                filename: `magnet:?xt=urn:btih:${magnetHash}&dn=Omnibus%20Transmission%20Live%20Test`,
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

            const downloads = mapTransmissionDownloads(await getTransmissionTorrents(rpc), label, 'Transmission Live');
            expect(downloads).toContainEqual(expect.objectContaining({
                id: torrentHash, name: 'Omnibus Transmission Live Test', status: 'Stopped', clientName: 'Transmission Live',
            }));

            await rpc('torrent_remove', { ids: [torrentHash], delete_local_data: true });
            torrentHash = undefined;

            const afterRemoval = await rpc('torrent_get', { ids: [magnetHash], fields: ['id', 'hash_string'] });
            expect(afterRemoval.torrents).toHaveLength(0);
        } finally {
            if (torrentHash) {
                await rpc('torrent_remove', { ids: [torrentHash], delete_local_data: true }).catch(() => undefined);
            }
        }
    }, 30000);
});