// src/lib/metadata/providers/metron-cover.ts
import axios from 'axios';
import { getCachedResponse, putCachedResponse } from '@/lib/metadata/metadata-cache';
import { logApiUsage } from '@/lib/utils/system-flags';

/** Lightweight Metron cover lookup, used as a fallback when ComicVine has no image. */
export async function getMetronCover(seriesName: string, issueNumber: string, user?: string, pass?: string): Promise<string | null> {
    if (!user || !pass) return null;
    try {
        const url = `https://metron.cloud/api/issue/?series_name=${encodeURIComponent(seriesName)}&number=${encodeURIComponent(issueNumber)}`;
        const hit = await getCachedResponse('metron', url);
        if (hit !== null) return hit?.results?.[0]?.image || null;

        const res = await axios.get(`https://metron.cloud/api/issue/`, {
            params: { series_name: seriesName, number: issueNumber },
            auth: { username: user, password: pass },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 4000
        });
        try { await logApiUsage('metron', '/issue'); } catch { /* accounting must never fail a fetch */ }
        if (res.status === 200 && res.data) await putCachedResponse('metron', url, res.data);
        return res.data?.results?.[0]?.image || null;
    } catch {
        return null;
    }
}
