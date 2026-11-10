import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { Logger } from '@/lib/logger'
import { isInactivityExpired, windowRole } from '@/lib/session-timeout'
import { buildCsp, cspHeaderName, cspMode, makeNonce } from '@/lib/csp'
export async function middleware(req: NextRequest) {
  const token = await getToken({ req })
  // A token flagged { error: "SessionExpired" } by the jwt callback is still a truthy object, and
  // an idle-beyond-window token may exist in a cookie that was never rewritten (no client refetch
  // ran). Both must be treated as logged out server-side, not just by the client-side signOut.
  const isAuth = !!token
    && !token.error
    && !isInactivityExpired(windowRole(token), token.lastActive)

  const pathname = req.nextUrl.pathname
  const isAuthPage = pathname.startsWith('/login')
  const isAdminPage = pathname.startsWith('/admin')
  const isSetupPage = pathname.startsWith('/setup')
  // #206: the Komga-compatible facade lives at /komga/api/v1 (Paperback's built-in source appends
  // /api/v1 to a Server URL of <origin>/komga). It is an API surface, not a page — without this a
  // Basic-only client was redirected to /login and parsed the HTML as JSON.
  // #262: so is the Komga-shaped OPDS catalog at /komga/opds/v1.2, read by Panels with Basic auth.
  const isApiRoute = pathname.startsWith('/api') || pathname.startsWith('/komga/api') || pathname.startsWith('/komga/opds')

  // --- 1. API ROUTE PROTECTION (Returns 401 JSON) ---
  if (isApiRoute) {
    // Whitelist API routes that are designed to be public
    const publicApiRoutes = [
        '/api/auth',          // NextAuth handles its own security
        '/api/setup/check',   // Used to determine if the wizard should show
        '/api/admin/test',              // Used during setup
        '/api/admin/prowlarr/indexers', // Used during setup
        '/api/admin/config',            // Used to save setup (route handles its own auth)
        '/api/admin/restore',           // Used to restore during setup
        '/api/admin/update-check',     // Used by the frontend to check for updates, but has its own internal key check
        '/api/cron',          // Hit by external uptime monitors
        '/api/v1/stats',      // Validates its own custom x-api-key
        '/api/uploads',       // Serves public avatars and banners
        '/api/opds',          // Serves uploaded files but checks for valid keys in the route handler
        '/api/koreader',      // KOReader devices auth via x-auth-user/x-auth-key (no NextAuth cookie); each handler self-validates
        '/komga/api',         // Komga-compatible facade for Paperback (#206): Basic auth = API key, each handler self-validates
        '/komga/opds',        // The Komga-shaped OPDS catalog for Panels (#262): checks keys in the /api/opds handlers it reuses
        '/api/internal'       // Rust engine callbacks (notify/log) auth via X-Internal-Secret (no NextAuth cookie); each handler self-validates (issue #178)
    ];
    
    const isPublicApi = publicApiRoutes.some(route => pathname.startsWith(route));

    // If it's a private API and the user has no token, block them instantly
    if (!isAuth && !isPublicApi) {
        Logger.log(`[Middleware Debug] Blocked unauthorized API request to ${pathname} (No Token)`, 'debug');
        return NextResponse.json({ error: "Unauthorized Access" }, { status: 401 });
    }

    // --- SECURITY FIX: Global Admin API Protection ---
    const isAdminApi = pathname.startsWith('/api/admin');
    if (isAdminApi && !isPublicApi && token?.role !== 'ADMIN') {
        Logger.log(`[Middleware Debug] Blocked unauthorized Admin API request to ${pathname} (Role: ${token?.role || 'None'})`, 'debug');
        return NextResponse.json({ error: "Forbidden: Admin privileges required." }, { status: 403 });
    }
  }

  // --- 2. FRONTEND UI PROTECTION (Returns 302 Redirect) ---
      if (!isApiRoute) {
          // If NOT logged in, NOT on the login page, and NOT on the setup page -> Kick to login
          if (!isAuth && !isAuthPage && !isSetupPage) {
            Logger.log(`[Middleware Debug] Redirecting unauthenticated user from ${pathname} to /login`, 'debug');
            return NextResponse.redirect(new URL('/login', req.url))
          }

          // Redirect to Home if already logged in and visiting the login page
          if (isAuth && isAuthPage) {
            return NextResponse.redirect(new URL('/', req.url))
          }

          // Protect Admin UI routes
          if (isAdminPage) {
            if (token?.role !== "ADMIN") {
              Logger.log(`[Middleware Debug] Redirecting non-admin user (Role: ${token?.role || 'None'}) from Admin UI ${pathname} to /`, 'debug');
              return NextResponse.redirect(new URL('/', req.url))
            }
          }
      }

  // Pass the current URL to Server Components (Used by layout.tsx for zero-flash setup check)
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', pathname);

  // --- 3. CONTENT-SECURITY-POLICY (pages only; src/lib/csp.ts) ---
  // A nonce or policy the browser sent is never passed on. The render reads ours: x-nonce for the root
  // layout's inline scripts, and the policy header itself, which Next reads to nonce its own scripts.
  requestHeaders.delete('x-nonce');
  requestHeaders.delete('content-security-policy');
  requestHeaders.delete('content-security-policy-report-only');
  const cspHeader = isApiRoute ? null : cspHeaderName(cspMode(process.env.OMNIBUS_CSP));
  let policy: string | null = null;
  if (cspHeader) {
    const nonce = makeNonce();
    policy = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development' });
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set(cspHeader, policy);
  }

  const res = NextResponse.next({
    request: {
      headers: requestHeaders,
    }
  })
  if (cspHeader && policy) res.headers.set(cspHeader, policy);
  return res
}

// The middleware now guards everything except static assets
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ]
}