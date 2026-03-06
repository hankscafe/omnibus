import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import bcrypt from 'bcryptjs';

export async function POST(req: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        
        const userId = (session.user as any).id;
        const body = await req.json();
        const { action } = body;

        // ACTION: Revoke All Other Sessions
        if (action === 'revoke_sessions') {
            const updatedUser = await prisma.user.update({
                where: { id: userId },
                data: { sessionVersion: { increment: 1 } }
            });

            return NextResponse.json({ 
                success: true, 
                message: "All other devices have been signed out.",
                newSessionVersion: updatedUser.sessionVersion 
            });
        }

        // ACTION: Change Password
        if (action === 'change_password') {
            const { currentPassword, newPassword } = body;
            
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user || !user.password) {
                return NextResponse.json({ error: "SSO users cannot change passwords here." }, { status: 400 });
            }

            const isValid = await bcrypt.compare(currentPassword, user.password);
            if (!isValid) return NextResponse.json({ error: "Incorrect current password." }, { status: 400 });

            const hashedPassword = await bcrypt.hash(newPassword, 10);
            
            await prisma.user.update({
                where: { id: userId },
                data: { 
                    password: hashedPassword,
                    sessionVersion: { increment: 1 } // Automatically log out other devices on password change
                }
            });

            return NextResponse.json({ success: true, message: "Password updated successfully." });
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}