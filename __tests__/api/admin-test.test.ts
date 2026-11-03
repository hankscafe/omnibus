import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/admin/test/route';
import { makePostJson } from '../helpers/request';

const mocks = vi.hoisted(() => ({
    post: vi.fn(),
    findUniqueSetting: vi.fn(),
    getServerSession: vi.fn(),
}));

vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/metron/client', () => ({ authFromSettings: vi.fn(), metronGet: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findUnique: mocks.findUniqueSetting } },
}));

const createReq = makePostJson('http://localhost/api/admin/test');
const config = {
    clientType: 'transmission', url: 'http://transmission:9091', user: 'rpc-user', pass: 'rpc-pass',
};

describe('Admin Transmission connection test', () => {
    beforeEach(() => {
        mocks.post.mockReset();
        mocks.findUniqueSetting.mockResolvedValue({ value: 'true' });
        mocks.getServerSession.mockResolvedValue({ user: { role: 'ADMIN' } });
    });

    it('succeeds when the daemon returns its version', async () => {
        mocks.post.mockResolvedValueOnce({ data: { result: 'success', arguments: { version: '4.0.6' } } });

        const response = await POST(createReq({ type: 'clients', config }));

        expect(await response.json()).toEqual({ success: true, message: 'Transmission Connected! (4.0.6)' });
        expect(mocks.post).toHaveBeenCalledWith(
            'http://transmission:9091/transmission/rpc',
            { method: 'session-get', arguments: {}, tag: 1 },
            expect.objectContaining({ auth: { username: 'rpc-user', password: 'rpc-pass' } }),
        );
    });

    it('fails when the daemon responds without a version', async () => {
        mocks.post.mockResolvedValueOnce({ data: { jsonrpc: '2.0', result: {} } });

        const response = await POST(createReq({ type: 'clients', config }));

        expect(await response.json()).toEqual({
            success: false,
            message: 'Transmission responded without a version. Check the RPC endpoint and credentials.',
            code: 'CONNECTION_ERROR',
        });
    });
});