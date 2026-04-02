import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function PUT(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    try {
        const { updates } = await request.json(); // Array of { id, number, name, releaseDate }
        
        const transactions = updates.map((update: any) => 
            prisma.issue.update({
                where: { id: update.id },
                data: { 
                    number: update.number, 
                    name: update.name, 
                    releaseDate: update.releaseDate 
                }
            })
        );

        await prisma.$transaction(transactions);
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}