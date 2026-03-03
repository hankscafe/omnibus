import { NextResponse } from 'next/server';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(Logger.getLogs());
}

export async function DELETE() {
  Logger.clear();
  return NextResponse.json({ success: true });
}