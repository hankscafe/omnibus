import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const issueId = searchParams.get('issueId');
    if (!issueId) return NextResponse.json({ volumeId: 0, year: null });

    try {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        if (!setting?.value) return NextResponse.json({ volumeId: 0, year: null });

        const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issue/4040-${issueId}/`, {
            params: { api_key: setting.value, format: 'json', field_list: 'volume,cover_date' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 5000
        });
        
        const volId = cvRes.data.results?.volume?.id ? parseInt(cvRes.data.results.volume.id) : 0;
        const year = cvRes.data.results?.cover_date ? cvRes.data.results.cover_date.split('-')[0] : null;

        return NextResponse.json({ volumeId: volId, year });
    } catch (error: unknown) {
        Logger.log(`[Lookup Volume API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ volumeId: 0, year: null });
    }
}