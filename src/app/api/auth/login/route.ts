import { NextRequest, NextResponse } from 'next/server'

async function hashPassword(password: string): Promise<string> {
  const encoded = new TextEncoder().encode(password)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const password: string = body?.password ?? ''

  const expected = process.env.PANTANI_PASSWORD
  if (!expected || password !== expected) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  const token = await hashPassword(password)
  const redirectTo = body?.from && body.from !== '/login' ? body.from : '/'

  const response = NextResponse.json({ success: true, redirectTo })
  response.cookies.set('pantani_auth', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  })

  return response
}

export async function DELETE() {
  const response = NextResponse.json({ success: true })
  response.cookies.delete('pantani_auth')
  return response
}
