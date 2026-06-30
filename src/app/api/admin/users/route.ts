import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import bcrypt from 'bcryptjs';
// --- CHANGED: Using unified SystemNotifier ---
import { SystemNotifier } from '@/lib/notifications';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';
import { setUserLibraryAccess, grantAllLibraries, getDefaultLibraryIds } from '@/lib/library-access';
import { TIER_ALL_LIBRARIES, type TierName } from '@/lib/permission-tiers';

export async function GET(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const users = await prisma.user.findMany({
      select: { 
          id: true, username: true, email: true, role: true, 
          isApproved: true, autoApproveRequests: true, canRequest: true, canDownload: true, canCreateGlobalLists: true,
          createdAt: true, twoFactorEnabled: true,
          libraryAccess: { select: { libraryId: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json(users);
  } catch (error) {
    Logger.log(`[Users API] Fetch Error: ${(error as Error).message}`, 'error');
    return NextResponse.json({ error: 'Failed to fetch users. Check server logs.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id, isApproved, role, autoApproveRequests, canRequest, canDownload, canCreateGlobalLists, reset2FA, libraryIds, tier } = await req.json();

    if (id === token.id && role !== undefined && role !== 'ADMIN') {
        return NextResponse.json({ error: "You cannot remove your own Admin privileges." }, { status: 400 });
    }

    const oldUser = await prisma.user.findUnique({ where: { id } });

    const updateData: any = {};
    if (isApproved !== undefined) updateData.isApproved = isApproved;
    if (role !== undefined) updateData.role = role;
    if (autoApproveRequests !== undefined) updateData.autoApproveRequests = autoApproveRequests;
    if (canRequest !== undefined) updateData.canRequest = canRequest;
    if (canDownload !== undefined) updateData.canDownload = canDownload;
    if (canCreateGlobalLists !== undefined) updateData.canCreateGlobalLists = canCreateGlobalLists;

    if (role !== undefined) {
        updateData.role = role;
        if (role === 'ADMIN') {
            updateData.isApproved = true;
            updateData.autoApproveRequests = true;
            updateData.canRequest = true;
            updateData.canDownload = true;
            updateData.canCreateGlobalLists = true;
        }
    }
    
    if (reset2FA) {
        updateData.twoFactorEnabled = false;
        updateData.twoFactorSecret = null;
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData
    });

    await AuditLogger.log('UPDATE_USER_PERMISSIONS', { 
        targetUserId: id, 
        updatedFields: updateData 
    }, token.id as string);

    if (isApproved === true && oldUser && !oldUser.isApproved) {
        // --- CHANGED: Unified Notifier Call ---
        SystemNotifier.sendAlert('account_approved', {
            user: updatedUser.username,
            email: updatedUser.email
        }).catch(() => {});
    }

    // Library access: an explicit list wins; otherwise a tier sets its library policy (Civilian/Sidekick →
    // default Comics, Vigilante/Hero → all libraries); promoting to ADMIN grants all.
    if (Array.isArray(libraryIds)) {
        await setUserLibraryAccess(id, libraryIds);
    } else if (tier && (tier as TierName) in TIER_ALL_LIBRARIES) {
        if (TIER_ALL_LIBRARIES[tier as TierName]) await grantAllLibraries(id);
        else await setUserLibraryAccess(id, await getDefaultLibraryIds());
    } else if (updateData.role === 'ADMIN') {
        await grantAllLibraries(id);
    }

    const finalUser = await prisma.user.findUnique({
        where: { id },
        include: { libraryAccess: { select: { libraryId: true } } }
    });
    const { password: _pw, ...safeUser } = (finalUser ?? updatedUser) as any;
    return NextResponse.json({ success: true, user: safeUser });
  } catch (error) {
    Logger.log(`[Users API] Update Error: ${(error as Error).message}`, 'error');
    return NextResponse.json({ error: 'Failed to update user. Check server logs.' }, { status: 500 });
  }
}

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

    await AuditLogger.log('DELETE_USER', { userId: id }, token.id as string);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log(`[Users API] Delete Error: ${error.message}`, 'error');
    return NextResponse.json({ error: 'Failed to delete user. Check server logs.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
      const body = await req.json();
      const { username, email, password, role, isApproved, autoApproveRequests, canRequest, canDownload, canCreateGlobalLists, tier } = body;

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

      const hashedPassword = await bcrypt.hash(password, 12); // standardized to 12 (register/reset/change all use 12)

      const newUser = await prisma.user.create({
          data: {
              username,
              email,
              password: hashedPassword,
              role: role || 'USER',
              isApproved: isApproved !== undefined ? isApproved : true,
              autoApproveRequests: role === 'ADMIN' ? true : (autoApproveRequests || false),
              canRequest: role === 'ADMIN' ? true : (canRequest || false),
              canDownload: role === 'ADMIN' ? true : (canDownload || false),
              canCreateGlobalLists: role === 'ADMIN' ? true : (canCreateGlobalLists || false)
          }
      });

      // Seed library access: admins (and "all libraries" tiers) get everything; everyone else the default Comics library.
      if ((role || 'USER') === 'ADMIN' || (tier && TIER_ALL_LIBRARIES[tier as TierName])) await grantAllLibraries(newUser.id);
      else await setUserLibraryAccess(newUser.id, await getDefaultLibraryIds());

      await AuditLogger.log('CREATE_USER', {
          targetUser: username,
          role: newUser.role
      }, token.id as string);

      const created = await prisma.user.findUnique({
          where: { id: newUser.id },
          include: { libraryAccess: { select: { libraryId: true } } }
      });
      const { password: _, ...safeUser } = (created ?? newUser) as any;
      return NextResponse.json(safeUser);

  } catch (e: any) {
      Logger.log(`[Users API] Create Error: ${e.message}`, 'error');
      return NextResponse.json({ error: "Failed to create user. Please check server logs." }, { status: 500 });
  }
}