import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { SystemNotifier } from '@/lib/notifications';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        if (!session || !userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { seriesId, description } = await request.json();

        if (!seriesId || !description) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const report = await prisma.issueReport.create({
            data: {
                userId,
                seriesId,
                description
            }
        });

        // Alert admins that a report landed (Adam's admin-controls ask, 2026-08-19). Fire-and-forget
        // through SystemNotifier — Discord webhooks, email, and push channels each apply their own
        // 'issue_reported' event subscription; a dead webhook must never fail the user's report.
        (async () => {
            let series: { name: string | null; coverUrl: string | null; publisher: string | null; year: number | null } | null = null;
            try {
                series = await prisma.series.findUnique({
                    where: { id: seriesId },
                    select: { name: true, coverUrl: true, publisher: true, year: true }
                });
            } catch (e) { /* alert degrades to text-only — the report itself already landed */ }
            await SystemNotifier.sendAlert('issue_reported', {
                title: series?.name || 'Unknown Series',
                description,
                user: (session.user as any)?.name || 'A user',
                imageUrl: series?.coverUrl || null,
                publisher: series?.publisher || null,
                year: series?.year ? String(series.year) : null,
                date: new Date().toLocaleString()
            });
        })().catch((e: unknown) => Logger.log(`[Reports] issue_reported alert failed: ${getErrorMessage(e)}`, 'warn'));

        return NextResponse.json({ success: true, report });

    } catch (error: unknown) {
        Logger.log(`Report Creation Error: ${getErrorMessage(error)}`, 'error');

        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
