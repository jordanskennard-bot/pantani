'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const from = searchParams.get('from') ?? '/'

  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, from }),
      })

      const data = await res.json()

      if (res.ok) {
        router.push(data.redirectTo ?? '/')
        router.refresh()
      } else {
        setError(data.error ?? 'Incorrect password')
      }
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">

        {/* Mark + wordmark */}
        <div className="flex items-center gap-2 mb-2">
          <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ width: 32, height: 26, flexShrink: 0 }}>
            <g transform="translate(16, 24)">
              <line x1="120" y1="10" x2="120" y2="16" stroke="var(--rosa)" strokeWidth="1.5" strokeLinecap="butt" />
              <path d="M 0 110 C 14 109, 22 108, 32 106 C 46 103, 60 99, 72 92 C 86 84, 96 70, 104 56 C 112 42, 116 30, 120 18 L 124 30 C 130 46, 138 64, 148 80 C 156 92, 162 100, 168 110" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit="10" fill="none" />
              <line x1="0" y1="110" x2="168" y2="110" stroke="var(--ink)" strokeWidth="1.25" />
            </g>
          </svg>
          <span style={{ fontFamily: 'var(--serif)', fontSize: '1.1rem', color: 'var(--ink)', letterSpacing: 'var(--tracking-tight)' }}>
            Pantani
          </span>
        </div>

        <p className="caption mb-10">Libro di corsa</p>

        <hr className="rule mb-6" style={{ marginTop: 0 }} />

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="input"
          />
          <button
            type="submit"
            disabled={loading || !password}
            className="btn"
          >
            {loading ? '...' : 'Enter'}
          </button>
        </form>

        {error && (
          <p className="body-sm mt-3" style={{ color: 'var(--rosa)' }}>{error}</p>
        )}

      </div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
