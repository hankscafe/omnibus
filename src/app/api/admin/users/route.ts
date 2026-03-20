import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import bcrypt from 'bcryptjs';
import { DiscordNotifier } from '@/lib/discord';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const users = await prisma.user.findMany({
      select: { 
          id: true, username: true, email: true, role: true, 
          isApproved: true, autoApproveRequests: true, canDownload: true, 
          createdAt: true, twoFactorEnabled: true 
      },
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json(users);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id, isApproved, role, autoApproveRequests, canDownload, reset2FA } = await req.json();

    if (id === token.id && role !== undefined && role !== 'ADMIN') {
        return NextResponse.json({ error: "You cannot remove your own Admin privileges." }, { status: 400 });
    }

    // Grab the old state to check for transition
    const oldUser = await prisma.user.findUnique({ where: { id } });

    let updateData: any = {};
    if (isApproved !== undefined) updateData.isApproved = isApproved;
    if (role !== undefined) updateData.role = role;
    if (autoApproveRequests !== undefined) updateData.autoApproveRequests = autoApproveRequests;
    if (canDownload !== undefined) updateData.canDownload = canDownload;
    
    if (reset2FA) {
        updateData.twoFactorEnabled = false;
        updateData.twoFactorSecret = null;
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData
    });

    // TRIGGER DISCORD NOTIFICATION
    if (isApproved === true && oldUser && !oldUser.isApproved) {
        DiscordNotifier.sendAlert('account_approved', {
            user: updatedUser.username,
            email: updatedUser.email
        }).catch(() => {});
    }

    return NextResponse.json({ success: true, user: updatedUser });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

// Delete User endpoint
export async function DELETE(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'User ID required' }, { status: 400 });

    if (id === token.id) {
        return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
    }

    await prisma.request.deleteMany({
        where: { userId: id }
    });

    await prisma.user.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) || 'Failed to delete user' }, { status: 500 });
  }
}

// Create User endpoint
export async function POST(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
      const body = await req.json();
      const { username, email, password, role, isApproved, autoApproveRequests, canDownload } = body;

      if (!username || !email || !password) {
          return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }

      const existingUser = await prisma.user.findFirst({
          where: {
              OR: [
                  { username: username },
                  { email: email }
              ]
          }
      });

      if (existingUser) {
          return NextResponse.json({ error: "Username or Email already in use." }, { status: 400 });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await prisma.user.create({
          data: {
              username,
              email,
              password: hashedPassword,
              role: role || 'USER',
              isApproved: isApproved !== undefined ? isApproved : true,
              autoApproveRequests: autoApproveRequests || false,
              canDownload: canDownload || false
          }
      });

      const { password: _, ...safeUser } = newUser;
      return NextResponse.json(safeUser);

  } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
  }
}