// src/lib/metadata/providers/metron-cover.ts
import axios from 'axios';

/** Lightweight Metron cover lookup, used as a fallback when ComicVine has no image. */
export async function getMetronCover(seriesName: string, issueNumber: string, user?: string, pass?: string): Promise<string | null> {
    if (!user || !pass) return null;
    try {
        const res = await axios.get(`https://metron.cloud/api/issue/`, {
            params: { series_name: seriesName, number: issueNumber },
            auth: { username: user, password: pass },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 4000
        });
        return res.data?.results?.[0]?.image || null;
    } catch {
        return null;
    }
}
