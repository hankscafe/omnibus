// src/app/api/user/api-keys/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const userId = (session.user as any).id;
        
        // Use the new dedicated table!
        const opdsKeys = await prisma.opdsKey.findMany({
            where: { userId: userId },
            orderBy: { createdAt: 'desc' }
        });
        
        return NextResponse.json(opdsKeys);
    } catch (error) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { name } = await request.json();
        if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

        const userId = (session.user as any).id;

        const rawKey = 'omn_' + crypto.randomBytes(32).toString('hex');
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const prefix = rawKey.substring(0, 12) + '...';

        // Save to the new dedicated table
        const newKey = await prisma.opdsKey.create({
            data: { name, keyHash, prefix, userId }
        });

        return NextResponse.json({ success: true, rawKey, apiKey: newKey });
    } catch (error) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

        const userId = (session.user as any).id;

        const key = await prisma.opdsKey.findUnique({ where: { id } });
        if (!key || key.userId !== userId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        await prisma.opdsKey.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}