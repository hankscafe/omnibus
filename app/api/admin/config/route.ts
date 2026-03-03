import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET(request: Request) {
  // Only admins can view the raw configuration keys
  const authOptions = await getAuthOptions();
  const session = await getServerSession(authOptions);
  
  if (session?.user?.role !== 'ADMIN') {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.systemSetting.findMany();
  return NextResponse.json(settings);
}

export async function POST(request: Request) {
  try {
    // SECURITY LOCK: Check if setup has already been completed
    const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
    const isSetupComplete = setupStatus?.value === 'true';

    // If setup IS complete, demand a valid Admin session
    if (isSetupComplete) {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized. Setup is already complete." }, { status: 403 });
        }
    }

    const body = await request.json();
    
    // We force every single value to be a string before saving.
    const operations = Object.entries(body).map(([key, value]) => {
      let stringValue: string;

      if (value === null || value === undefined) {
        stringValue = "";
      } else if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      return prisma.systemSetting.upsert({
        where: { key },
        update: { value: stringValue },
        create: { key, value: stringValue }
      });
    });

    await prisma.$transaction(operations);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Settings Save Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}