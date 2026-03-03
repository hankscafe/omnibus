import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import bcrypt from 'bcryptjs';

export async function GET(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, email: true, role: true, isApproved: true, autoApproveRequests: true, canDownload: true, createdAt: true },
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
    const { id, isApproved, role, autoApproveRequests, canDownload } = await req.json();

    if (id === token.id && role !== 'ADMIN') {
        return NextResponse.json({ error: "You cannot remove your own Admin privileges." }, { status: 400 });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { isApproved, role, autoApproveRequests, canDownload }
    });

    return NextResponse.json({ success: true, user: updatedUser });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

// NEW: Delete User endpoint
export async function DELETE(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'User ID required' }, { status: 400 });

    // Prevent admins from deleting themselves
    if (id === token.id) {
        return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
    }

    // Clean up associated requests first to avoid foreign key constraint errors
    await prisma.request.deleteMany({
        where: { userId: id }
    });

    // Delete the user
    await prisma.user.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to delete user' }, { status: 500 });
  }
}

// NEW: Create User endpoint
export async function POST(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
      const body = await req.json();
      const { username, email, password, role, isApproved, autoApproveRequests, canDownload } = body;

      // Validation
      if (!username || !email || !password) {
          return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }

      // Check if user already exists
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

      // Hash Password securely
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create User
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

      // Strip password before returning the payload to the frontend
      const { password: _, ...safeUser } = newUser;
      return NextResponse.json(safeUser);

  } catch (e: any) {
      console.error("Failed to create user:", e);
      return NextResponse.json({ error: e.message }, { status: 500 });
  }
}