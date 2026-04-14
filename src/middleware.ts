import { NextRequest, NextResponse } from 'next/server'

// Routes that don't require authentication
const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/api/ingest/email',   // Postmark webhook — has its own key auth
  '/api/poll-youtube',   // Vercel cron — internal only
]

async function hashPassword(password: string): Promise<string> {
  const encoded = new TextEncoder().encode(password)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow public paths through
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const password = process.env.PANTANI_PASSWORD
  if (!password) {
    // No password set — allow through (dev mode / not yet configured)
    return NextResponse.next()
  }

  const expectedToken = await hashPassword(password)
  const cookieToken = request.cookies.get('pantani_auth')?.value

  if (cookieToken === expectedToken) {
    return NextResponse.next()
  }

  // Not authenticated — redirect to login
  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('from', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
