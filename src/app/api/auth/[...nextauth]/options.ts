import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";

// FIX: Safely extract authenticator regardless of how Webpack nests the CommonJS export
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
        
        const users: any[] = await prisma.$queryRaw`
          SELECT * FROM User 
          WHERE LOWER(username) = ${input} OR LOWER(email) = ${input} 
          LIMIT 1
        `;
        
        const user = users[0];

        if (!user) throw new Error("Invalid username or password");
        if (!user.password) throw new Error("Please log in using SSO.");

        const isPasswordValid = await bcrypt.compare(credentials.password, user.password);
        if (!isPasswordValid) throw new Error("Invalid username or password");
        if (!user.isApproved) throw new Error("Account pending admin approval.");

        // --- 2FA VERIFICATION LOGIC ---
        if (user.twoFactorEnabled && user.twoFactorSecret) {
            
            // Strictly catch the "undefined" serialization quirk from NextAuth
            if (!credentials.totpCode || credentials.totpCode === "undefined" || credentials.totpCode.trim() === "") {
                throw new Error("2FA_REQUIRED"); 
            }
            
            const isValid = typeof authenticator.verify === 'function'
                ? authenticator.verify({ token: credentials.totpCode, secret: user.twoFactorSecret })
                : authenticator.check(credentials.totpCode, user.twoFactorSecret);
                
            if (!isValid) {
                throw new Error("Invalid 2FA code.");
            }
        }

        return { 
            id: user.id, 
            name: user.username, 
            email: user.email,
            role: user.role,
            autoApproveRequests: user.autoApproveRequests, 
            canDownload: user.canDownload,
            image: user.avatar,
            sessionVersion: user.sessionVersion // <-- Added for Revoke Sessions
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
    secret: process.env.NEXTAUTH_SECRET, // <-- FIX: Explicitly bind the secret here
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
            const userCount = await prisma.user.count();
            const isFirstUser = userCount === 0;
            dbUser = await prisma.user.create({
              data: {
                username: user.name || user.email.split('@')[0],
                email: user.email,
                password: '',
                role: isFirstUser ? "ADMIN" : "USER",
                isApproved: isFirstUser ? true : false,
                autoApproveRequests: isFirstUser ? true : false,
                canDownload: isFirstUser ? true : false,
              }
            });
          }
          if (!dbUser.isApproved) return false;
          user.id = dbUser.id;
          (user as any).role = dbUser.role;
          (user as any).autoApproveRequests = dbUser.autoApproveRequests;
          (user as any).canDownload = dbUser.canDownload;
          user.image = dbUser.avatar; 
          (user as any).sessionVersion = dbUser.sessionVersion; // <-- Added for Revoke Sessions
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
          token.sessionVersion = (user as any).sessionVersion; // <-- Added for Revoke Sessions
          token.lastActive = Date.now();
        }

        if (trigger === "update") {
            if (session?.user?.image !== undefined) token.picture = session.user.image;
            // Update session version live if the user revoked other sessions from this browser
            if (session?.sessionVersion !== undefined) token.sessionVersion = session.sessionVersion; 
            token.lastActive = Date.now();
        }

        // 1. Time-based Expiration Check
        if (token.lastActive) {
            const timeoutLimit = token.role === "ADMIN" ? ADMIN_TIMEOUT_MS : USER_TIMEOUT_MS;
            if (Date.now() - (token.lastActive as number) > timeoutLimit) {
                return { error: "SessionExpired" };
            } else {
                token.lastActive = Date.now();
            }
        }

        // 2. Database Session Version Check (Revoke Sessions)
        if (token.id) {
            const dbUser = await prisma.user.findUnique({
                where: { id: token.id as string },
                select: { sessionVersion: true }
            });
            // FIX: Safely fallback to 0 if the token is from before the DB update
            if (dbUser && dbUser.sessionVersion !== (token.sessionVersion || 0)) {
                return { error: "SessionExpired" };
            }
        }

        const cookieStore = await cookies();
        const impersonateId = cookieStore.get('omnibus_impersonate')?.value;

        if (token.role === "ADMIN" && !token.originalAdminId) {
            token.originalAdminId = token.id;
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