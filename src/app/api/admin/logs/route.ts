import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(Logger.getLogs());
}

export async function DELETE() {
  try {
      const authOptions = await getAuthOptions();
      const session = await getServerSession(authOptions);
      const userId = (session?.user as any)?.id;

      Logger.clear();
      if (userId) await AuditLogger.log('CLEARED_SYSTEM_LOGS', "Cleared the physical omnibus.log file.", userId);
      
      return NextResponse.json({ success: true });
  } catch (error: unknown) {
      Logger.log(`[Logs API] Delete Error: ${getErrorMessage(error)}`, 'error');
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}