import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { authenticateKoreader } from '@/lib/koreader-auth';

export async function GET(request: Request) {
    try {
        const user = await authenticateKoreader(request);
        if (!user) return NextResponse.json({ authorized: "KO" }, { status: 401 });

        return NextResponse.json({ authorized: "OK" });
    } catch (error: unknown) {
        Logger.log(`[KOReader Auth API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ authorized: "KO" }, { status: 500 });
    }
}
