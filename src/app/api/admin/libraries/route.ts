// src/app/api/admin/libraries/route.ts
//
// Admin-only list of libraries, used by the User Management page to render per-user library-access
// checkboxes. Read-only; the canonical library CRUD lives under the settings flow.
import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';

export async function GET(req: NextRequest) {
  const token = await getToken({ req });
  if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const libraries = await prisma.library.findMany({
    select: { id: true, name: true, isManga: true, isDefault: true },
    orderBy: [{ isManga: 'asc' }, { name: 'asc' }],
  });
  return NextResponse.json(libraries);
}
