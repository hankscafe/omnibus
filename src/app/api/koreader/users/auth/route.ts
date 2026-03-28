import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import crypto from 'crypto';

export async function authenticateKoreader(request: Request) {
    const userHeader = request.headers.get('x-auth-user');
    const keyHeader = request.headers.get('x-auth-key');

    if (!userHeader || !keyHeader) return null;

    // Hash the incoming key to match the database
    const keyHash = crypto.createHash('sha256').update(keyHeader).digest('hex');

    // Authenticate using Omnibus OPDS API Keys
    const opdsKey = await prisma.opdsKey.findUnique({
        where: { keyHash },
        include: { user: true }
    });

    if (opdsKey && opdsKey.user.username === userHeader) {
        // Optional: Update last used timestamp
        prisma.opdsKey.update({ where: { id: opdsKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return opdsKey.user;
    }

    // Fallback: Check Admin API Keys
    const adminKey = await prisma.apiKey.findUnique({
        where: { keyHash },
        include: { user: true }
    });

    if (adminKey && adminKey.user.username === userHeader) {
        prisma.apiKey.update({ where: { id: adminKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return adminKey.user;
    }

    return null;
}

export async function GET(request: Request) {
    const user = await authenticateKoreader(request);
    if (!user) return NextResponse.json({ authorized: "KO" }, { status: 401 });
    
    return NextResponse.json({ authorized: "OK" });
}