import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import bcrypt from 'bcryptjs';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { checkRateLimit } from '@/lib/rate-limit';

export async function POST(req: Request) {
  const token = await getToken({ req: req as any });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimit = checkRateLimit(`change_pw_${token.id}`, 5, 15 * 60 * 1000);
  if (rateLimit.isLimited) return rateLimit.response!;

  try {
    const { currentPassword, newPassword } = await req.json();

    const user = await prisma.user.findUnique({ where: { id: token.id as string } });
    if (!user) {
        rateLimit.trackFailure();
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Prevent SSO users from trying to change passwords locally
    if (!user.password) {
        rateLimit.trackFailure();
        return NextResponse.json({ error: 'SSO accounts must change passwords at their provider.' }, { status: 400 });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      rateLimit.trackFailure();
      return NextResponse.json({ error: 'Incorrect current password.' }, { status: 400 });
    }

    // Enforce identical complexity rules
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
    if (!passwordRegex.test(newPassword)) {
      rateLimit.trackFailure();
      return NextResponse.json({ 
        error: "Password must be at least 12 characters and include uppercase, lowercase, numbers, and symbols." 
      }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: { 
          password: hashedPassword,
          sessionVersion: { increment: 1 } // Instantly revoke all other sessions
      }
    });

    await AuditLogger.log('CHANGED_PASSWORD', "User changed their password.", user.id);
    Logger.log(`[Auth] User ${user.username} successfully changed their password.`, 'success');
    
    rateLimit.trackSuccess();
    return NextResponse.json({ success: true, message: 'Password updated successfully.' });

  } catch (error: unknown) {
    rateLimit.trackFailure();
    Logger.log(`[Auth] Error changing password: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}