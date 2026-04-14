'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function LoginPage() {
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
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M16 2L28 9V23L16 30L4 23V9L16 2Z" stroke="#1a1a18" strokeWidth="2" fill="none"/>
            <path d="M16 8L22 12V20L16 24L10 20V12L16 8Z" fill="#1a1a18"/>
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
