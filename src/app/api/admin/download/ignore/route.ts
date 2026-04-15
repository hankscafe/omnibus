import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        const { downloadId } = await request.json();
        if (!downloadId) return NextResponse.json({ error: "Missing downloadId" }, { status: 400 });

        const setting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_downloads' } });
        let ignored: string[] = [];
        
        if (setting?.value) {
            try { ignored = JSON.parse(setting.value); } catch (e) {}
        }

        if (!ignored.includes(downloadId)) {
            ignored.push(downloadId);
        }

        await prisma.systemSetting.upsert({
            where: { key: 'ignored_downloads' },
            update: { value: JSON.stringify(ignored) },
            create: { key: 'ignored_downloads', value: JSON.stringify(ignored) }
        });

        if (userId) {
            await AuditLogger.log('IGNORED_DOWNLOAD', { downloadId }, userId);
        }

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Ignore DL] Failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}