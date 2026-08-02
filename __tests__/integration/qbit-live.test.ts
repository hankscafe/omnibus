// @vitest-environment node
//
// OPT-IN live-contract test for qBittorrent auth (issue #193).
// (node environment is REQUIRED: under the suite's default jsdom, axios uses the XHR
// adapter and every real request dies as "Network Error".)
//
// qBittorrent 5.2 rewrote the login responses (success: 200+"Ok."+SID cookie → 204+empty
// body+QBT_SID_<port> cookie; wrong credentials: 200+"Fails." → 401), which the mocked unit
// suite can only assert against RECORDED shapes. This file runs the REAL qbitAuthHeaders
// against a REAL qBittorrent so the contract itself is exercised — use it whenever a new
// qBittorrent major/minor ships:
//
//   docker run -d --name qbit-live -p 8080:8080 -e QBT_LEGAL_NOTICE=confirm \
//     qbittorrentofficial/qbittorrent-nox:<version>
//   docker logs qbit-live   # grab the temporary password
//   QBIT_LIVE_URL=http://localhost:8080 QBIT_LIVE_USER=admin QBIT_LIVE_PASS=<pw> npx vitest run __tests__/integration/qbit-live.test.ts
//
// Skipped entirely (describe.skip) when QBIT_LIVE_URL is unset — CI never runs it.
// CAUTION: the wrong-credentials case counts toward qBittorrent's failed-login ban
// (5 strikes → 1h IP ban); restart the container to clear a ban between repeated runs.
import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';

// Mock ONLY the app plumbing download-clients drags in at import time — axios stays REAL.
vi.mock('@/lib/db', () => ({ prisma: { customHeader: { findMany: vi.fn().mockResolvedValue([]) } } }));
vi.mock('@/lib/importer', () => ({ Importer: {} }));

import { qbitAuthHeaders } from '@/lib/download-clients';

const url = process.env.QBIT_LIVE_URL;

(url ? describe : describe.skip)('LIVE: qbitAuthHeaders against a real qBittorrent', () => {
    it('username/password login succeeds and the returned headers authenticate an API call', async () => {
        const headers = await qbitAuthHeaders(
            { user: process.env.QBIT_LIVE_USER || 'admin', pass: process.env.QBIT_LIVE_PASS || '' },
            url!, {}, 10000,
        );
        // Whatever cookie shape this qBittorrent uses, the headers must actually work.
        const res = await axios.get(`${url}/api/v2/app/version`, { headers, timeout: 10000 });
        expect(res.status).toBe(200);
        expect(String(res.data)).toMatch(/^v?\d/);
    });

    it('wrong credentials map to the credential message (401 on 5.2+, "Fails." on older)', async () => {
        await expect(
            qbitAuthHeaders({ user: process.env.QBIT_LIVE_USER || 'admin', pass: 'definitely-wrong-xyz' }, url!, {}, 10000),
        ).rejects.toThrow(/rejected the username\/password/);
    });
});
