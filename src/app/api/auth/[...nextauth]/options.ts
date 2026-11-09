// src/app/api/auth/[...nextauth]/options.ts
import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { decrypt2FA } from "@/lib/encryption";
import { Logger } from "@/lib/logger";
import { grantAllLibraries, setUserLibraryAccess, getDefaultLibraryIds } from "@/lib/library-access";
import { isInactivityExpired, windowRole } from "@/lib/session-timeout";
import { IMPERSONATION_COOKIE, readImpersonationCookie } from "@/lib/impersonation";

// --- SECURITY SAFEGUARD ---
const defaultSecret = 'change_this_to_a_random_secure_string_123!';

if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET === defaultSecret) {
    Logger.log("CRITICAL SECURITY ERROR: NEXTAUTH_SECRET is insecure or missing. Omnibus is shutting down.", 'error');
    const isBuildPhase = process.env.npm_lifecycle_event === 'build' || process.env.CI === 'true';
    if (!isBuildPhase) {
        process.exit(1); 
    }
}

// --- SECURITY: IN-MEMORY RATE LIMITER ---
const globalForRateLimit = globalThis as unknown as {
    loginAttempts: Map<string, { count: number, lockoutUntil: number }>
};
if (!globalForRateLimit.loginAttempts) {
    globalForRateLimit.loginAttempts = new Map();
}
const loginAttempts = globalForRateLimit.loginAttempts;

// otplib is CommonJS; require() with the interop fallback below avoids ESM default-interop pitfalls.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const otplib = require('otplib');
const authenticator = otplib.authenticator || otplib.default?.authenticator || otplib;

export async function getAuthOptions(): Promise<NextAuthOptions> {
  let oidcEnabled = false;
  let oidcIssuer = "";
  let oidcClientId = "";
  let oidcClientSecret = "";
  
  // --- NEW SSO SETTINGS ---
  // (Force SSO isn't read here: it's enforced by the login page's redirect, registration and password
  // reset. Password sign-in stays registered for the ?local=true bypass.)
  let oidcAutoApprove = false;
  let oidcAdminGroup = "";
  let oidcUserGroup = "";

  try {
    const configs = await prisma.systemSetting.findMany({
      where: { key: { in: ['oidc_enabled', 'oidc_issuer', 'oidc_client_id', 'oidc_client_secret', 'oidc_auto_approve', 'oidc_admin_group', 'oidc_user_group'] } }
    });
    const configMap = Object.fromEntries(configs.map(c => [c.key, c.value]));
    
    oidcEnabled = configMap.oidc_enabled === 'true';
    oidcIssuer = configMap.oidc_issuer || "";
    oidcClientId = configMap.oidc_client_id || "";
    oidcClientSecret = configMap.oidc_client_secret || "";
    oidcAutoApprove = configMap.oidc_auto_approve === 'true';
    oidcAdminGroup = configMap.oidc_admin_group || "";
    oidcUserGroup = configMap.oidc_user_group || "";
  } catch (e) {}

  const providers: any[] = [
    // ALWAYS register the CredentialsProvider so the backend can handle ?local=true bypasses
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
          const attemptData = loginAttempts.get(input) || { count: 0, lockoutUntil: 0 };
          if (Date.now() < attemptData.lockoutUntil) {
              const remainingMinutes = Math.ceil((attemptData.lockoutUntil - Date.now()) / 60000);
              throw new Error(`Account locked due to too many failed attempts. Try again in ${remainingMinutes} minutes.`);
          }
          const users: any[] = await prisma.$queryRaw`SELECT * FROM "User" WHERE LOWER(username) = ${input} OR LOWER(email) = ${input} LIMIT 1`;
          const user = users[0];
          const handleFailedAttempt = () => {
              attemptData.count += 1;
              if (attemptData.count >= 5) attemptData.lockoutUntil = Date.now() + 15 * 60 * 1000;
              loginAttempts.set(input, attemptData);
              throw new Error("Invalid username or password");
          };
          if (!user) handleFailedAttempt();
          if (!user.password) throw new Error("Please log in using SSO.");
          const isPasswordValid = await bcrypt.compare(credentials.password, user.password);
          if (!isPasswordValid) handleFailedAttempt();
          if (!user.isApproved) throw new Error("Account pending admin approval.");
          if (user.twoFactorEnabled && user.twoFactorSecret) {
              if (!credentials.totpCode || credentials.totpCode === "undefined" || credentials.totpCode.trim() === "") throw new Error("2FA_REQUIRED"); 
              const decryptedSecret = await decrypt2FA(user.twoFactorSecret);
              const isValid = typeof authenticator.verify === 'function' ? authenticator.verify({ token: credentials.totpCode, secret: decryptedSecret }) : authenticator.check(credentials.totpCode, decryptedSecret);
              // A wrong TOTP after a CORRECT password is a distinct failure: don't increment the password
              // lockout (a few mistyped codes must not lock a verified-password account) and don't report
              // "invalid username or password". The login UI maps '2FA_INVALID' onto the 2FA screen.
              if (!isValid) throw new Error("2FA_INVALID");
          }
          loginAttempts.delete(input);
          // Every tier flag, like the SSO path below: the browser's request buttons read canRequest
          // from the session, and a password sign-in without it showed every Hero "Requests not enabled".
          return { id: user.id, name: user.username, email: user.email, role: user.role, canRequest: user.canRequest, autoApproveRequests: user.autoApproveRequests, canDownload: user.canDownload, canCreateGlobalLists: user.canCreateGlobalLists, image: user.avatar, sessionVersion: user.sessionVersion };
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
      authorization: { params: { scope: "openid email profile groups roles" } },
      idToken: true,
      checks: ["pkce", "state"],
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      profile(profile: any) {
        // Log only the identifying fields, not the whole profile — the raw payload can carry arbitrary
        // IdP claims (phone, address, etc.) that don't belong in the app log even at debug level.
        Logger.log(`[SSO Debug] Received OIDC profile for sub=${profile.sub} email=${profile.email}`, 'debug');
        return {
          id: profile.sub, 
          name: profile.name || profile.preferred_username || profile.nickname || profile.email?.split('@')[0] || "SSO User", 
          email: profile.email,
          groups: profile.groups || profile.roles || [] 
        };
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
          Logger.log(`[SSO Debug] Processing sign in for: ${user.email}`, 'debug');
          const inputEmail = user.email.toLowerCase();
          const dbUsers: any[] = await prisma.$queryRaw`SELECT * FROM "User" WHERE LOWER(email) = ${inputEmail} LIMIT 1`;
          let dbUser = dbUsers[0];

          // Determine target role & approval based on configuration
          let targetRole = "USER";
          let isApproved = oidcAutoApprove;

          const userGroups = Array.isArray(user.groups) ? user.groups : [];
          Logger.log(`[SSO Debug] Extracted User Groups: ${JSON.stringify(userGroups)}. Checking against Admin Group: "${oidcAdminGroup}" and User Group: "${oidcUserGroup}"`, 'debug');
          const hasAdminGroup = oidcAdminGroup && userGroups.includes(oidcAdminGroup);
          const hasUserGroup = oidcUserGroup && userGroups.includes(oidcUserGroup);

          // Group enforcement if configured
          if (oidcAdminGroup || oidcUserGroup) {
              if (hasAdminGroup) {
                Logger.log(`[SSO Debug] User matched Admin Group criteria. Granting ADMIN role.`, 'debug');
                  targetRole = "ADMIN";
                  isApproved = true; // Admins map implicitly handles approval
              } else if (hasUserGroup) {
                Logger.log(`[SSO Debug] User matched User Group criteria. Granting USER role.`, 'debug');
                  targetRole = "USER";
              } else {
                Logger.log(`[SSO Debug] Login rejected for ${user.email}: User does not belong to the required OIDC groups.`, 'debug');
                  Logger.log(`[SSO] Login rejected for ${user.email}: User does not belong to the required OIDC groups.`, 'warn');
                  return false;
              }
          }

          if (!dbUser) {
            dbUser = await prisma.user.create({ 
              data: { 
                username: user.name || user.email.split('@')[0], 
                email: user.email, 
                password: '', 
                role: targetRole,
                isApproved: isApproved,
                autoApproveRequests: targetRole === "ADMIN",
                canRequest: targetRole === "ADMIN",
                canDownload: targetRole === "ADMIN",
                canCreateGlobalLists: targetRole === "ADMIN"
              } 
            });
            const firstUserInDb = await prisma.user.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
            if (firstUserInDb?.id === dbUser.id && targetRole !== "ADMIN") {
                dbUser = await prisma.user.update({ where: { id: dbUser.id }, data: { role: "ADMIN", isApproved: true, autoApproveRequests: true, canRequest: true, canDownload: true, canCreateGlobalLists: true } });
            }
            // Seed library access for the brand-new SSO user (admins get all; others the default Comics library).
            if (dbUser.role === 'ADMIN') await grantAllLibraries(dbUser.id);
            else await setUserLibraryAccess(dbUser.id, await getDefaultLibraryIds());
          } else {
              // Update role if groups shifted
              if ((oidcAdminGroup || oidcUserGroup) && dbUser.role !== targetRole) {
                  dbUser = await prisma.user.update({
                      where: { id: dbUser.id },
                      data: { 
                          role: targetRole,
                          isApproved: isApproved,
                          autoApproveRequests: targetRole === "ADMIN" ? true : dbUser.autoApproveRequests,
                          canRequest: targetRole === "ADMIN" ? true : dbUser.canRequest,
                          canDownload: targetRole === "ADMIN" ? true : dbUser.canDownload,
                          canCreateGlobalLists: targetRole === "ADMIN" ? true : dbUser.canCreateGlobalLists,
                      }
                  });
              }
          }

          if (!dbUser.isApproved) return false;
          user.id = dbUser.id;
          user.role = dbUser.role;
          user.autoApproveRequests = dbUser.autoApproveRequests;
          user.canRequest = dbUser.canRequest;
          user.canDownload = dbUser.canDownload;
          user.canCreateGlobalLists = dbUser.canCreateGlobalLists;
          user.image = dbUser.avatar; 
          user.sessionVersion = dbUser.sessionVersion; 
          return true;
        }
        return false;
      },
      async jwt({ token, user, trigger, session }) {
        if (user) {
          token.id = user.id;
          token.role = user.role;
          token.autoApproveRequests = user.autoApproveRequests;
          token.canRequest = user.canRequest;
          token.canDownload = user.canDownload;
          token.canCreateGlobalLists = user.canCreateGlobalLists;
          token.picture = user.image;
          token.sessionVersion = user.sessionVersion;
          token.lastActive = Date.now();
          token.lastSessionCheck = Date.now();
          // An impersonation cookie counts only if it was issued after this — signing out and back
          // in no longer resumes one (the cookie outlives sign-out).
          token.signedInAt = Date.now();
        }
        // Expiry gate BEFORE the update-trigger slide: a queued activity ping must not revive a
        // session that already timed out. An impersonating session keeps the admin's window.
        if (isInactivityExpired(windowRole(token), token.lastActive as number)) return { error: "SessionExpired" };
        if (trigger === "update") {
            if (session?.user?.image !== undefined) token.picture = session.user.image;
            if (session?.sessionVersion !== undefined) token.sessionVersion = session.sessionVersion;
            token.lastActive = Date.now();
            // No lastSessionCheck stamp here: the ping comes at most every 5 minutes on input, so
            // stamping it starved the sweep below for any active user — revocations and permission
            // changes never reached them.
        }
        // Deliberately NO lastActive refresh on ambient reads (the SessionProvider's 300s refetch
        // and background polls run this callback constantly and used to keep the window from ever
        // elapsing). The window slides only at sign-in and via the SessionActivityTracker ping.
        if (token.id) {
            const now = Date.now();
            const lastCheck = (token.lastSessionCheck as number) || 0;
            if (now - lastCheck > 5 * 60 * 1000) {
                // Fail OPEN on a THROWN read (fork review 2026-07-29, their #4): SQLite busy while a
                // restore monopolizes the single connection, or a pg blip, used to throw out of this
                // callback and kill the session — a surprise logout for every open tab. A revocation
                // verdict still requires a read that RESOLVES (a deleted user resolves null and
                // expires); only exceptions defer. lastSessionCheck is stamped either way so a
                // struggling DB gets one probe per 5-minute cycle, not one per session fetch —
                // which bounds the fail-open window for a revoked session to that same cycle.
                //
                // The same read refreshes role + tier flags: an admin applying a tier (or a role) to a
                // signed-in user changes only the database, and the session used to keep its sign-in
                // copy until the user signed out. While impersonating, the session is still the admin's
                // — revocation is judged on the admin's own row, and the target's flags (copied at the
                // swap below) are left alone.
                const impersonating = !!(token.isImpersonating && token.originalAdminId);
                try {
                    const dbUser = await prisma.user.findUnique({
                        where: { id: (impersonating ? token.originalAdminId : token.id) as string },
                        select: { sessionVersion: true, role: true, canRequest: true, autoApproveRequests: true, canDownload: true, canCreateGlobalLists: true },
                    });
                    if (!dbUser || dbUser.sessionVersion !== (token.sessionVersion || 0)) return { error: "SessionExpired" };
                    if (!impersonating) {
                        token.role = dbUser.role;
                        token.canRequest = dbUser.canRequest;
                        token.autoApproveRequests = dbUser.autoApproveRequests;
                        token.canDownload = dbUser.canDownload;
                        token.canCreateGlobalLists = dbUser.canCreateGlobalLists;
                    }
                } catch (e) {
                    Logger.log(`[Auth] sessionVersion check deferred on transient DB error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
                }
                token.lastSessionCheck = now;
            }
        }

        const cookieStore = await cookies();
        if (token.role === "ADMIN" && !token.originalAdminId) token.originalAdminId = token.id;

        // Genuine, started by this session's admin, issued during this sign-in, inside its hour.
        const impersonateId = readImpersonationCookie(cookieStore.get(IMPERSONATION_COOKIE)?.value, {
            secret: process.env.NEXTAUTH_SECRET,
            adminId: token.originalAdminId,
            signedInAt: token.signedInAt,
        });
        // Same fail-open posture as the sessionVersion sweep: a thrown lookup leaves this round's
        // token unchanged (the cookie/token state persists, so the swap or revert simply retries on
        // the next callback run) instead of killing the admin's session.
        if (impersonateId && token.originalAdminId) {
            if (token.id !== impersonateId) {
                try {
                    const targetUser = await prisma.user.findUnique({ where: { id: impersonateId } });
                    if (targetUser) {
                        // Keep the admin's own name/email to restore on the way back (an SSO admin's
                        // display name isn't their username).
                        if (!token.isImpersonating) { token.originalAdminName = token.name; token.originalAdminEmail = token.email; }
                        token.id = targetUser.id; token.role = targetUser.role; token.autoApproveRequests = targetUser.autoApproveRequests;
                        token.canRequest = targetUser.canRequest; token.canDownload = targetUser.canDownload; token.canCreateGlobalLists = targetUser.canCreateGlobalLists; token.picture = targetUser.avatar;
                        token.name = targetUser.username; token.email = targetUser.email; token.isImpersonating = true;
                    }
                } catch (e) {
                    Logger.log(`[Auth] Impersonation swap deferred on transient DB error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
                }
            }
        } else if (!impersonateId && token.isImpersonating) {
            try {
                const adminUser = await prisma.user.findUnique({ where: { id: token.originalAdminId as string } });
                if (adminUser) {
                    token.id = adminUser.id; token.role = adminUser.role; token.autoApproveRequests = adminUser.autoApproveRequests;
                    token.canRequest = adminUser.canRequest; token.canDownload = adminUser.canDownload; token.canCreateGlobalLists = adminUser.canCreateGlobalLists; token.picture = adminUser.avatar;
                    token.name = (token.originalAdminName as string | null | undefined) ?? adminUser.username;
                    token.email = (token.originalAdminEmail as string | null | undefined) ?? adminUser.email;
                    delete token.originalAdminName; delete token.originalAdminEmail;
                    token.isImpersonating = false;
                }
            } catch (e) {
                Logger.log(`[Auth] Impersonation revert deferred on transient DB error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
            }
        }
        return token as any;
      },
      async session({ session, token }) {
        if (token.error === "SessionExpired") return { ...session, user: undefined, error: "SessionExpired" } as any;
        if (session?.user) {
          session.user.id = token.id; session.user.role = token.role;
          session.user.autoApproveRequests = token.autoApproveRequests; session.user.canDownload = token.canDownload;
          session.user.canRequest = token.canRequest;
          session.user.canCreateGlobalLists = token.canCreateGlobalLists;
          session.user.isImpersonating = token.isImpersonating;
          let pic = token.picture as string | null;
          if (pic && !pic.startsWith('/') && !pic.startsWith('http')) pic = `/${pic}`;
          session.user.image = pic || null;
        }
        return session;
      }
    },
    pages: { signIn: "/login", error: "/login" },
    session: { strategy: "jwt", maxAge: 6 * 60 * 60, updateAge: 15 * 60 }
  };
}