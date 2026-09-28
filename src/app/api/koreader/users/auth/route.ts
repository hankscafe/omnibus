import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { authenticateKoreader, koreaderUnauthorizedResponse } from '@/lib/koreader-auth';

export async function GET(request: Request) {
    try {
        const auth = await authenticateKoreader(request);
        if (!auth.user) return koreaderUnauthorizedResponse(auth.error);

        return NextResponse.json({ authorized: 'OK' });
    } catch (error: unknown) {
        Logger.log(`[KOReader Auth API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ code: 2000, message: 'KOReader authentication failed' }, { status: 500 });
    }
}
