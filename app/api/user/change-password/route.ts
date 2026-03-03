import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import bcrypt from 'bcryptjs';
import { Logger } from '@/lib/logger';

export async function POST(req: Request) {
  const token = await getToken({ req });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { currentPassword, newPassword } = await req.json();

    const user = await prisma.user.findUnique({ where: { id: token.id as string } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // Prevent SSO users from trying to change passwords locally
    if (!user.password) {
        return NextResponse.json({ error: 'SSO accounts must change passwords at their provider.' }, { status: 400 });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      return NextResponse.json({ error: 'Incorrect current password.' }, { status: 400 });
    }

    // Enforce identical complexity rules
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
    if (!passwordRegex.test(newPassword)) {
      return NextResponse.json({ 
        error: "Password must be at least 12 characters and include uppercase, lowercase, numbers, and symbols." 
      }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword }
    });

    Logger.log(`[Auth] User ${user.username} successfully changed their password.`, 'success');
    return NextResponse.json({ success: true, message: 'Password updated successfully.' });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}