export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cvId = searchParams.get('cvId');

  if (!cvId) return NextResponse.json({ owned: false });

  try {
    // Check if the ID exists in your local library table 
    // (Assuming you have a 'Library' or 'Comic' table with cvId)
    const comic = await prisma.comic.findUnique({
      where: { cvId: cvId.toString() }
    });

    return NextResponse.json({ owned: !!comic });
  } catch (error) {
    return NextResponse.json({ owned: false });
  }
}