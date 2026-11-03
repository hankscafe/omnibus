import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransmissionRpc, getTransmissionTorrents, transmissionRpcUrl } from '@/lib/transmission';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('axios', () => ({ default: { post: mocks.post } }));

describe('Transmission RPC', () => {
    beforeEach(() => mocks.post.mockReset());

    it('rejects JSON-RPC errors', async () => {
        mocks.post.mockResolvedValueOnce({ data: {
            jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params' },
        } });

        const rpc = createTransmissionRpc({ url: 'http://transmission:9091' }, {}, 5000);

        await expect(rpc('torrent_add')).rejects.toThrow('Transmission RPC torrent_add failed: Invalid params');
    });

    it('rejects unsuccessful legacy replies', async () => {
        mocks.post.mockResolvedValueOnce({ data: { result: 'invalid or corrupt torrent file' } });

        const rpc = createTransmissionRpc({ url: 'http://transmission:9091' }, {}, 5000);

        await expect(rpc('torrent_add')).rejects.toThrow('Transmission RPC torrent_add failed: invalid or corrupt torrent file');
    });

    it('rejects a session challenge without a session ID', async () => {
        mocks.post.mockRejectedValueOnce({ response: { status: 409, headers: {} } });

        const rpc = createTransmissionRpc({ url: 'http://transmission:9091' }, {}, 5000);

        await expect(rpc('session_get')).rejects.toThrow('Transmission returned HTTP 409 without an X-Transmission-Session-Id header.');
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });

    it('retries the 409 session challenge using JSON-RPC 2.0 for Transmission 4.1+', async () => {
        mocks.post
            .mockRejectedValueOnce({ response: { status: 409, headers: {
                'x-transmission-session-id': 'session-token',
                'x-transmission-rpc-version': '6.0.0',
            } } })
            .mockResolvedValueOnce({ data: { jsonrpc: '2.0', result: { version: '4.1.0' } } });

        const rpc = createTransmissionRpc(
            { url: 'http://transmission:9091', user: 'rpc-user', pass: 'rpc-pass' },
            { 'User-Agent': 'Omnibus/1.0' },
            5000,
        );
        const result = await rpc('session_get', { fields: ['version'] });

        expect(result.version).toBe('4.1.0');
        expect(mocks.post).toHaveBeenCalledTimes(2);
        expect(mocks.post.mock.calls[0][0]).toBe('http://transmission:9091/transmission/rpc');
        expect(mocks.post.mock.calls[1][1]).toEqual({
            jsonrpc: '2.0', method: 'session_get', params: { fields: ['version'] }, id: 1,
        });
        expect(mocks.post.mock.calls[1][2]).toMatchObject({
            auth: { username: 'rpc-user', password: 'rpc-pass' },
            headers: { 'X-Transmission-Session-Id': 'session-token' },
        });
    });

    it('keeps the legacy RPC format when the server does not advertise JSON-RPC 2.0', async () => {
        mocks.post
            .mockRejectedValueOnce({ response: { status: 409, headers: { 'x-transmission-session-id': 'legacy-token' } } })
            .mockResolvedValueOnce({ data: { result: 'success', arguments: { rpc_version: 16 } } });

        const rpc = createTransmissionRpc({ url: 'http://transmission:9091/transmission/rpc/' }, {}, 5000);
        const result = await rpc('session_get');

        expect(result.rpc_version).toBe(16);
        expect(mocks.post.mock.calls[1][1]).toEqual({
            method: 'session-get', arguments: {}, tag: 1,
        });
        expect(mocks.post.mock.calls[1][2].headers['X-Transmission-Session-Id']).toBe('legacy-token');
        expect(transmissionRpcUrl('http://transmission:9091/transmission/rpc/')).toBe('http://transmission:9091/transmission/rpc');
    });

    it('requests native labels when the daemon RPC version supports them', async () => {
        mocks.post
            .mockRejectedValueOnce({ response: { status: 409, headers: { 'x-transmission-session-id': 'token' } } })
            .mockResolvedValueOnce({ data: { result: 'success', arguments: { 'rpc-version': 16 } } })
            .mockResolvedValueOnce({ data: { result: 'success', arguments: { torrents: [] } } });

        const rpc = createTransmissionRpc({ url: 'http://transmission:9091' }, {}, 5000);
        await getTransmissionTorrents(rpc);

        expect(mocks.post.mock.calls[2][1].arguments.fields).toEqual([
            'id', 'name', 'hashString', 'percentDone', 'totalSize', 'status', 'labels',
        ]);
        expect(mocks.post.mock.calls[2][2].headers['X-Transmission-Session-Id']).toBe('token');
    });
});