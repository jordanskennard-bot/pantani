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
    <main
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: '#f5f4f0' }}
    >
      <div className="w-full max-w-sm">

        {/* Logo + wordmark */}
        <div className="flex items-center gap-2 mb-10">
          <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ width: 20, height: 20, flexShrink: 0 }}>
            <path d="M4 22 L16 10 L28 22" stroke="#1a1a18" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: '1.1rem', color: '#1a1a18', letterSpacing: '-0.01em' }}>
            Pantani
          </span>
        </div>

        <p className="text-sm mb-8" style={{ color: '#6b6b63' }}>
          Libro di corsa
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="rounded px-3 py-2 text-sm focus:outline-none"
            style={{ background: '#eceae4', border: '1px solid #d8d6ce', color: '#1a1a18' }}
          />
          <button
            type="submit"
            disabled={loading || !password}
            className="rounded px-4 py-2 text-sm transition-colors disabled:opacity-40"
            style={{ background: '#1a1a18', color: '#f5f4f0' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#2d2d2a')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1a1a18')}
          >
            {loading ? '...' : 'Enter'}
          </button>
        </form>

        {error && (
          <p className="text-xs mt-3 text-red-600">{error}</p>
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
