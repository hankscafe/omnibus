import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'

// 1. Explicitly name and export the middleware function
export async function middleware(req: NextRequest) {
  // Grab the secure session token 
  const token = await getToken({ req })
  const isAuth = !!token
  
  const pathname = req.nextUrl.pathname
  const isAuthPage = pathname.startsWith('/login')
  const isAdminPage = pathname.startsWith('/admin')

  // 1. If NOT logged in and NOT on the login page -> Kick to login
  if (!isAuth && !isAuthPage) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // 2. Redirect to Home if already logged in and visiting the login page
  if (isAuth && isAuthPage) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  // 3. Protect Admin routes
  if (isAdminPage) {
    // If they somehow bypassed the top check, or if they just aren't an ADMIN
    if (token?.role !== "ADMIN") {
      // Not an ADMIN? Kick to Home.
      return NextResponse.redirect(new URL('/', req.url))
    }
  }

  return NextResponse.next()
}

// 2. Export your config as usual
export const config = {
  matcher: [
    // This regex applies the proxy to all routes EXCEPT:
    // - /api/ (Allows NextAuth and your new v1 API to function normally)
    // - /_next/ (Next.js internals and static files)
    // - Static assets like favicon.ico, SVGs, PNGs, etc.
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ]
}