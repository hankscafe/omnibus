import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const reports = await prisma.issueReport.findMany({
            include: {
                user: { select: { username: true } },
                series: { select: { name: true, folderPath: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        return NextResponse.json(reports);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { id, status, adminComment } = await req.json();

        if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

        const updated = await prisma.issueReport.update({
            where: { id },
            data: { status, adminComment }
        });

        return NextResponse.json(updated);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}