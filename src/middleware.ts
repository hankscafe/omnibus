import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { Logger } from '@/lib/logger'
export async function middleware(req: NextRequest) {
  const token = await getToken({ req })
  const isAuth = !!token
  
  const pathname = req.nextUrl.pathname
  const isAuthPage = pathname.startsWith('/login')
  const isAdminPage = pathname.startsWith('/admin')
  const isSetupPage = pathname.startsWith('/setup')
  const isApiRoute = pathname.startsWith('/api')

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
        '/api/cron',          // Hit by external uptime monitors
        '/api/v1/stats',      // Validates its own custom x-api-key
        '/api/uploads',       // Serves public avatars and banners
        '/api/opds'           // Serves uploaded files but checks for valid keys in the route handler
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

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    }
  })
}

// The middleware now guards everything except static assets
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ]
}