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
          <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ width: 20, height: 20, flexShrink: 0 }}>
            <path d="M4 22 L16 10 L28 22" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter" />
          </svg>
          <span className="font-serif" style={{ fontSize: '1.1rem', color: 'var(--ink)', letterSpacing: 'var(--tracking-tight)' }}>
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
