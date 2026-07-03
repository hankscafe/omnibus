// src/app/api/internal/notify/route.ts
//
// Internal endpoint the Rust engine calls to fire a user-facing notification when a DETACHED job
// finishes, so alerts reflect actual completion rather than the 202 handoff. This is NOT a public
// route — it is authenticated by a shared secret (NEXTAUTH_SECRET, already shared with the engine for
// backup encryption) sent in the X-Internal-Secret header.
import { NextResponse } from 'next/server';
import { SystemNotifier } from '@/lib/notifications';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { secretsMatch } from '@/lib/api-auth';

export async function POST(request: Request) {
    const provided = request.headers.get('x-internal-secret');
    if (!secretsMatch(provided, process.env.NEXTAUTH_SECRET)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: any;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const event = body?.event;
    if (typeof event !== 'string' || !event) {
        return NextResponse.json({ error: 'Missing event' }, { status: 400 });
    }

    await SystemNotifier.sendAlert(event, body.payload || {})
        .catch((e: unknown) => Logger.log(`[InternalNotify] sendAlert('${event}') failed: ${getErrorMessage(e)}`, 'error'));

    return NextResponse.json({ success: true });
}
