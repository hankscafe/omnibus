import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { DiscordNotifier } from '@/lib/discord';

export async function POST(request: Request) {
  try {
    const { username, email, password } = await request.json();

    if (!username || !email || !password) {
      return NextResponse.json({ error: "Username, email, and password are required" }, { status: 400 });
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

    // 4. Determine Role (First user is automatically an Admin)
    const userCount = await prisma.user.count();
    const isFirstUser = userCount === 0;

    const hashedPassword = await bcrypt.hash(password, 12);

    // 5. Create User
    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        role: isFirstUser ? "ADMIN" : "USER",
        isApproved: isFirstUser ? true : false, // First user is auto-approved
        autoApproveRequests: isFirstUser ? true : false,
      }
    });

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

  } catch (error: any) {
    console.error("Registration Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}