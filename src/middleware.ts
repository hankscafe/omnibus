import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'

export async function middleware(req: NextRequest) {
  const token = await getToken({ req })
  const isAuth = !!token
  
  const pathname = req.nextUrl.pathname
  const isAuthPage = pathname.startsWith('/login')
  const isAdminPage = pathname.startsWith('/admin')
  const isSetupPage = pathname.startsWith('/setup') // <-- NEW: Identify the setup page

  // 1. If NOT logged in, NOT on the login page, and NOT on the setup page -> Kick to login
  if (!isAuth && !isAuthPage && !isSetupPage) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // 2. Redirect to Home if already logged in and visiting the login page
  if (isAuth && isAuthPage) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  // 3. Protect Admin routes
  if (isAdminPage) {
    if (token?.role !== "ADMIN") {
      return NextResponse.redirect(new URL('/', req.url))
    }
  }

  // 4. Pass the current URL to Server Components (Used by layout.tsx for zero-flash setup check)
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', pathname);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    }
  })
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ]
}