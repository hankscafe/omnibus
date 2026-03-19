import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { decrypt2FA } from "@/lib/encryption";
import crypto from "crypto";
import { Logger } from "@/lib/logger";

// --- SECURITY SAFEGUARD ---
const defaultSecret = 'change_this_to_a_random_secure_string_123!';

if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET === defaultSecret) {
    Logger.log("\n=========================================================================", 'error');
    Logger.log(" 🛑 CRITICAL SECURITY ERROR: INSECURE NEXTAUTH_SECRET DETECTED", 'error');
    Logger.log("=========================================================================", 'error');
    Logger.log(" You are using the default (or missing) NEXTAUTH_SECRET.", 'error');
    Logger.log(" This secret is used to encrypt your database backups and secure sessions.", 'error');
    Logger.log(" You MUST change this to a unique, secure string in your docker-compose.yml.", 'error');
    Logger.log(" Example command to generate one: openssl rand -base64 32", 'error');
    Logger.log(" Omnibus is shutting down to protect your data. Please update and restart.", 'error');
    Logger.log("=========================================================================\n", 'error');
    
    process.exit(1); 
}

// --- SECURITY: IN-MEMORY RATE LIMITER ---
// Preserved across hot-reloads in dev, persistent in production memory
const globalForRateLimit = globalThis as unknown as {
    loginAttempts: Map<string, { count: number, lockoutUntil: number }>
};
if (!globalForRateLimit.loginAttempts) {
    globalForRateLimit.loginAttempts = new Map();
}
const loginAttempts = globalForRateLimit.loginAttempts;

const otplib = require('otplib');
const authenticator = otplib.authenticator || otplib.default?.authenticator || otplib;

export async function getAuthOptions(): Promise<NextAuthOptions> {
  let oidcEnabled = false;
  let oidcIssuer = "";
  let oidcClientId = "";
  let oidcClientSecret = "";

  try {
    const configs = await prisma.systemSetting.findMany({
      where: { key: { in: ['oidc_enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_client_secret'] } }
    });
    const configMap = Object.fromEntries(configs.map(c => [c.key, c.value]));
    
    oidcEnabled = configMap.oidc_enabled === 'true';
    oidcIssuer = configMap.oidc_issuer || "";
    oidcClientId = configMap.oidc_client_id || "";
    oidcClientSecret = configMap.oidc_client_secret || "";
  } catch (e) {}

  const providers: any[] = [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
        totpCode: { label: "2FA Code", type: "text" }
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;
        
        const input = credentials.username.toLowerCase();

        // --- SECURITY FIX: Rate Limit Check ---
        const attemptData = loginAttempts.get(input) || { count: 0, lockoutUntil: 0 };
        if (Date.now() < attemptData.lockoutUntil) {
            const remainingMinutes = Math.ceil((attemptData.lockoutUntil - Date.now()) / 60000);
            throw new Error(`Account locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`);
        }
        
        const users: any[] = await prisma.$queryRaw`
          SELECT * FROM User 
          WHERE LOWER(username) = ${input} OR LOWER(email) = ${input} 
          LIMIT 1
        `;
        
        const user = users[0];

        // Helper function to handle failed attempts
        const handleFailedAttempt = () => {
            attemptData.count += 1;
            if (attemptData.count >= 5) {
                attemptData.lockoutUntil = Date.now() + 15 * 60 * 1000; // 15 minutes lockout
            }
            loginAttempts.set(input, attemptData);
            throw new Error("Invalid username or password");
        };

        if (!user) handleFailedAttempt();
        if (!user.password) throw new Error("Please log in using SSO.");

        const isPasswordValid = await bcrypt.compare(credentials.password, user.password);
        if (!isPasswordValid) handleFailedAttempt();
        
        if (!user.isApproved) throw new Error("Account pending admin approval.");

        if (user.twoFactorEnabled && user.twoFactorSecret) {
            if (!credentials.totpCode || credentials.totpCode === "undefined" || credentials.totpCode.trim() === "") {
                throw new Error("2FA_REQUIRED"); 
            }
            
            const decryptedSecret = decrypt2FA(user.twoFactorSecret);

            const isValid = typeof authenticator.verify === 'function'
                ? authenticator.verify({ token: credentials.totpCode, secret: decryptedSecret })
                : authenticator.check(credentials.totpCode, decryptedSecret);
                
            if (!isValid) handleFailedAttempt();
        }

        // --- SECURITY FIX: Clear failed attempts on successful login ---
        loginAttempts.delete(input);

        return { 
            id: user.id, 
            name: user.username, 
            email: user.email,
            role: user.role,
            autoApproveRequests: user.autoApproveRequests, 
            canDownload: user.canDownload,
            image: user.avatar,
            sessionVersion: user.sessionVersion 
        };
      }
    })
  ];

  if (oidcEnabled && oidcIssuer && oidcClientId && oidcClientSecret) {
    providers.push({
      id: "oidc",
      name: "OpenID Connect",
      type: "oauth",
      version: "2.0",
      wellKnown: `${oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      authorization: { params: { scope: "openid email profile" } },
      idToken: true,
      checks: ["pkce", "state"],
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      profile(profile: any) {
        return {
          id: profile.sub,
          name: profile.name || profile.preferred_username || profile.nickname || profile.email?.split('@')[0] || "SSO User",
          email: profile.email,
        }
      },
    });
  }

  return {
    providers,
    secret: process.env.NEXTAUTH_SECRET, 
    callbacks: {
      async signIn({ user, account }) {
        if (account?.provider === "credentials") return true;
        if (account?.provider === "oidc") {
          if (!user.email) return false;
          
          const inputEmail = user.email.toLowerCase();
          const dbUsers: any[] = await prisma.$queryRaw`
            SELECT * FROM User WHERE LOWER(email) = ${inputEmail} LIMIT 1
          `;
          
          let dbUser = dbUsers[0];
          
          if (!dbUser) {
            dbUser = await prisma.user.create({
              data: {
                username: user.name || user.email.split('@')[0],
                email: user.email,
                password: '',
                role: "USER",
                isApproved: false,
                autoApproveRequests: false,
                canDownload: false,
              }
            });

            const firstUserInDb = await prisma.user.findFirst({
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true }
            });

            if (firstUserInDb?.id === dbUser.id) {
                dbUser = await prisma.user.update({
                    where: { id: dbUser.id },
                    data: {
                        role: "ADMIN",
                        isApproved: true,
                        autoApproveRequests: true,
                        canDownload: true,
                    }
                });
            }
          }
          if (!dbUser.isApproved) return false;
          user.id = dbUser.id;
          (user as any).role = dbUser.role;
          (user as any).autoApproveRequests = dbUser.autoApproveRequests;
          (user as any).canDownload = dbUser.canDownload;
          user.image = dbUser.avatar; 
          (user as any).sessionVersion = dbUser.sessionVersion; 
          return true;
        }
        return false;
      },
      
      async jwt({ token, user, trigger, session }) {
        const ADMIN_TIMEOUT_MS = 2 * 60 * 60 * 1000; 
        const USER_TIMEOUT_MS = 6 * 60 * 60 * 1000;  

        if (user) {
          token.id = user.id;
          token.role = (user as any).role;
          token.autoApproveRequests = (user as any).autoApproveRequests;
          token.canDownload = (user as any).canDownload;
          token.picture = user.image;
          token.sessionVersion = (user as any).sessionVersion;
          token.lastActive = Date.now();
          token.lastSessionCheck = Date.now(); 
        }

        if (trigger === "update") {
            if (session?.user?.image !== undefined) token.picture = session.user.image;
            if (session?.sessionVersion !== undefined) token.sessionVersion = session.sessionVersion; 
            token.lastActive = Date.now();
            token.lastSessionCheck = Date.now(); 
        }

        if (token.lastActive) {
            const timeoutLimit = token.role === "ADMIN" ? ADMIN_TIMEOUT_MS : USER_TIMEOUT_MS;
            if (Date.now() - (token.lastActive as number) > timeoutLimit) {
                return { error: "SessionExpired" };
            } else {
                token.lastActive = Date.now();
            }
        }

        const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

        if (token.id) {
            const now = Date.now();
            const lastCheck = (token.lastSessionCheck as number) || 0;

            if (now - lastCheck > SESSION_CHECK_INTERVAL_MS) {
                const dbUser = await prisma.user.findUnique({
                    where: { id: token.id as string },
                    select: { sessionVersion: true }
                });
                
                if (dbUser && dbUser.sessionVersion !== (token.sessionVersion || 0)) {
                    return { error: "SessionExpired" };
                }
                
                token.lastSessionCheck = now;
            }
        }

        const cookieStore = await cookies();
        const rawImpersonateCookie = cookieStore.get('omnibus_impersonate')?.value;
        let impersonateId = null;

        if (token.role === "ADMIN" && !token.originalAdminId) {
            token.originalAdminId = token.id;
        }

        if (rawImpersonateCookie && token.originalAdminId) {
            const parts = rawImpersonateCookie.split('|');
            
            if (parts.length === 3) {
                const [targetId, cookieAdminId, signature] = parts;
                const secret = process.env.NEXTAUTH_SECRET || 'fallback_secret';
                
                const expectedSignature = crypto.createHmac('sha256', secret).update(`${targetId}|${cookieAdminId}`).digest('hex');
                
                if (signature === expectedSignature && cookieAdminId === token.originalAdminId) {
                    impersonateId = targetId;
                } else {
                    Logger.log("🛑 [Security] Blocked invalid or hijacked impersonation cookie replay.", 'warn');
                }
            }
        }

        if (impersonateId && token.originalAdminId) {
            if (token.id !== impersonateId) {
                const targetUser = await prisma.user.findUnique({ where: { id: impersonateId } });
                if (targetUser) {
                    token.id = targetUser.id;
                    token.role = targetUser.role;
                    token.autoApproveRequests = targetUser.autoApproveRequests;
                    token.canDownload = targetUser.canDownload;
                    token.picture = targetUser.avatar;
                    token.isImpersonating = true;
                }
            }
        } else if (!impersonateId && token.isImpersonating) {
            const adminUser = await prisma.user.findUnique({ where: { id: token.originalAdminId as string } });
            if (adminUser) {
                token.id = adminUser.id;
                token.role = adminUser.role;
                token.autoApproveRequests = adminUser.autoApproveRequests;
                token.canDownload = adminUser.canDownload;
                token.picture = adminUser.avatar;
                token.isImpersonating = false;
            }
        }

        return token;
      },
      
      async session({ session, token }) {
        if (token.error === "SessionExpired") {
            return { ...session, user: undefined, error: "SessionExpired" } as any;
        }
        if (session?.user) {
          (session.user as any).id = token.id;
          (session.user as any).role = token.role;
          (session.user as any).autoApproveRequests = token.autoApproveRequests;
          (session.user as any).canDownload = token.canDownload;
          (session.user as any).isImpersonating = token.isImpersonating;
          let pic = token.picture as string | null;
          if (pic && !pic.startsWith('/') && !pic.startsWith('http')) {
              pic = `/${pic}`;
          }
          session.user.image = pic || null;
        }
        return session;
      }
    },
    pages: { signIn: "/login", error: "/login" },
    session: { strategy: "jwt", maxAge: 6 * 60 * 60, updateAge: 15 * 60 }
  };
}