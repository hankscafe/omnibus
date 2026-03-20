import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { DiscordNotifier } from '@/lib/discord';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    // FIX: Safely parse JSON to prevent 500 crashes on malformed payloads
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
    }

    const { username, email, password } = body;

    if (!username || !email || !password) {
      return NextResponse.json({ error: "Username, email, and password are required" }, { status: 400 });
    }

    // FIX: Prevent ridiculous username lengths
    if (username.length > 50) {
        return NextResponse.json({ error: "Username must be 50 characters or less" }, { status: 400 });
    }

    // 1. Email Format Validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
    }

    // 2. Password Complexity Check
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
    if (!passwordRegex.test(password)) {
      return NextResponse.json({ 
        error: "Password must be at least 12 characters and include uppercase, lowercase, numbers, and symbols." 
      }, { status: 400 });
    }

    // 3. Check if username OR email already exists (SECURE DB-LEVEL CHECK)
    const inputUsername = username.toLowerCase();
    const inputEmail = email.toLowerCase();
    
    const existingUsers: any[] = await prisma.$queryRaw`
      SELECT id FROM User 
      WHERE LOWER(username) = ${inputUsername} OR LOWER(email) = ${inputEmail} 
      LIMIT 1
    `;
    
    if (existingUsers.length > 0) {
      return NextResponse.json({ error: "Username or email is already taken" }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // 4. Safely create the user with default low-level USER permissions
    let newUser = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        role: "USER",
        isApproved: false, 
        autoApproveRequests: false,
      }
    });

    // 5. SECURITY FIX: Post-creation promotion to prevent TOCTOU race conditions.
    // Find the chronologically oldest user in the DB. If it's this user, promote them to ADMIN.
    const firstUserInDb = await prisma.user.findFirst({
        orderBy: [
            { createdAt: 'asc' }, 
            { id: 'asc' } // Deterministic tie-breaker
        ],
        select: { id: true }
    });

    let isFirstUser = false;
    
    if (firstUserInDb?.id === newUser.id) {
        isFirstUser = true;
        newUser = await prisma.user.update({
            where: { id: newUser.id },
            data: {
                role: "ADMIN",
                isApproved: true,
                autoApproveRequests: true,
            }
        });
    }

    // 6. Send Discord Notification for New Users (Admins excluded)
    if (!isFirstUser) {
      await DiscordNotifier.sendAlert('pending_account', {
        title: "New Account Registration",
        user: username,
        email: email,
        date: new Date().toLocaleString()
      });
    }

    return NextResponse.json({ 
      success: true, 
      message: isFirstUser ? "Admin account created successfully." : "Account created successfully. Please wait for an admin to approve your account."
    });

  } catch (error: unknown) {
    Logger.log(`Registration Error: ${getErrorMessage(error)}`, 'error');

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}