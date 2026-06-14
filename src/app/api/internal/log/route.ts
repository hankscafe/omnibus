// src/app/api/internal/log/route.ts
//
// Internal endpoint the Rust engine streams its log lines to, so engine activity appears inline in
// the same Node debug logger / UI viewer (and omnibus.log file) as the Node app's own logs — giving
// one unified troubleshooting view across the hybrid. NOT a public route: authenticated by the shared
// secret (NEXTAUTH_SECRET) in the X-Internal-Secret header, same as /api/internal/notify.
import { NextResponse } from 'next/server';
import { Logger } from '@/lib/logger';

type IncomingLine = { level?: string; message?: string };

const ALLOWED_LEVELS = new Set(['info', 'warn', 'error', 'success', 'debug']);

export async function POST(request: Request) {
    const expected = process.env.NEXTAUTH_SECRET;
    const provided = request.headers.get('x-internal-secret');
    if (!expected || !provided || provided !== expected) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: any;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const lines: IncomingLine[] = Array.isArray(body?.lines) ? body.lines : [];
    for (const line of lines) {
        const message = typeof line?.message === 'string' ? line.message : '';
        if (!message) continue;
        const level = (typeof line?.level === 'string' && ALLOWED_LEVELS.has(line.level))
            ? (line.level as 'info' | 'warn' | 'error' | 'success' | 'debug')
            : 'info';
        // Tag every engine line so it's distinguishable from Node lines in the unified log. The
        // Logger applies its own debug-level filter (engine debug shows only when the UI is in debug).
        Logger.log(`[Engine] ${message}`, level);
    }

    return NextResponse.json({ success: true });
}
