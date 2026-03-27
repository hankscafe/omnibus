// src/app/api/koreader/users/auth/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function authenticateKoreader(request: Request) {
    const userHeader = request.headers.get('x-auth-user');
    const keyHeader = request.headers.get('x-auth-key');

    if (!userHeader || !keyHeader) return null;

    // Authenticate using Omnibus OPDS API Keys
    const apiKey = await prisma.apiKey.findUnique({
        where: { key: keyHeader },
        include: { user: true }
    });

    if (apiKey && apiKey.user.username === userHeader) {
        return apiKey.user;
    }

    return null;
}

export async function GET(request: Request) {
    const user = await authenticateKoreader(request);
    if (!user) return NextResponse.json({ authorized: "KO" }, { status: 401 });
    
    return NextResponse.json({ authorized: "OK" });
}