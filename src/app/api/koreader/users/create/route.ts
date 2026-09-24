import { NextResponse } from 'next/server';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { authenticateKoreader } from '@/lib/koreader-auth';

const INVALID_CREDENTIALS = 'Unauthorized. Use an API key created after KOReader support was added.';

export async function POST(request: Request) {
    try {
        const { username, password } = await request.json();
        if (typeof username !== 'string' || typeof password !== 'string') {
            return NextResponse.json({ code: 2002, message: INVALID_CREDENTIALS }, { status: 402 });
        }

        // KOReader hashes the entered password with md5 before sending the registration body. Omnibus
        // accounts already exist, so Register is the same credential check as Login.
        const authRequest = new Request(request.url, {
            headers: {
                'x-auth-user': username,
                'x-auth-key': password,
            },
        });
        const auth = await authenticateKoreader(authRequest);
        if (!auth.user) {
            return NextResponse.json({
                code: 2002,
                message: auth.error === 'Unauthorized' ? INVALID_CREDENTIALS : auth.error,
            }, { status: 402 });
        }

        return NextResponse.json({ username: auth.user.username }, { status: 201 });
    } catch (error: unknown) {
        Logger.log(`[KOReader User Create API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json(
            { code: 2000, message: 'Unable to validate KOReader credentials' },
            { status: 500 },
        );
    }
}
