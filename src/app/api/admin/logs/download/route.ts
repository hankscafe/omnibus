// src/app/api/admin/logs/download/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        // Ensure only Admins can download the raw server logs
        if (session?.user?.role !== 'ADMIN') {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        // Dynamically find the log file using the same logic from logger.ts
        const logDir = process.env.OMNIBUS_LOGS_DIR || path.join(process.cwd(), 'config', 'logs');
        const logFile = path.join(logDir, 'omnibus.log');

        if (!fs.existsSync(logFile)) {
            return new NextResponse("Log file not found or has not been generated yet.", { status: 404 });
        }

        const fileBuffer = fs.readFileSync(logFile);

        return new NextResponse(fileBuffer, {
            headers: {
                'Content-Type': 'text/plain',
                'Content-Disposition': `attachment; filename="omnibus_server_${new Date().toISOString().split('T')[0]}.log"`,
            },
        });
    } catch (error: unknown) {
        return new NextResponse("Failed to download log file: " + getErrorMessage(error), { status: 500 });
    }
}