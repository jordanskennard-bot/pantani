'use client'

import { useState, useCallback, useEffect, useRef } from 'react'

type QueueItem = {
  id: string
  file: File
  status: 'queued' | 'processing' | 'done' | 'duplicate' | 'error'
  message?: string
}

type Document = {
  id: string
  created_at: string
  source_type: 'email' | 'file' | 'url'
  source_ref: string | null
  source_from: string | null
  title: string | null
  token_count: number | null
  summary: string | null
  tags: string[]
}

const TAG_COLOURS: Record<string, string> = {
  competitive_intel:  'bg-rose-100 text-rose-700',
  programmatic:       'bg-blue-100 text-blue-700',
  cpm_benchmarks:     'bg-amber-100 text-amber-700',
  attribution:        'bg-purple-100 text-purple-700',
  audience:           'bg-teal-100 text-teal-700',
  merchant_profile:   'bg-green-100 text-green-700',
  category_knowledge: 'bg-orange-100 text-orange-700',
  platform_intel:     'bg-sky-100 text-sky-700',
  regulation:         'bg-stone-100 text-stone-600',
}

const SOURCE_ICONS: Record<string, string> = {
  email: '✉',
  file: '▣',
  url: '⬡',
}

const SOURCE_LABELS: Record<string, string> = {
  email: 'Email',
  file: 'File',
  url: 'Link',
}

export default function Home() {
  const [url, setUrl] = useState('')
  const [urlStatus, setUrlStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [urlMessage, setUrlMessage] = useState('')

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const processingRef = useRef(false)

  const [documents, setDocuments] = useState<Document[]>([])
  const [docsLoading, setDocsLoading] = useState(true)

  const fetchDocs = useCallback(async () => {
    const res = await fetch('/api/knowledge')
    if (res.ok) {
      const data = await res.json()
      setDocuments(data.documents ?? [])
    }
    setDocsLoading(false)
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  async function submitUrl(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    setUrlStatus('loading')
    setUrlMessage('')
    try {
      const res = await fetch('/api/ingest/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (res.ok) {
        setUrlStatus('ok')
        setUrlMessage(`Ingested "${data.title}" (${data.chunkCount} chunks)`)
        setUrl('')
        fetchDocs()
      } else {
        setUrlStatus('error')
        setUrlMessage(data.error ?? 'Unknown error')
      }
    } catch {
      setUrlStatus('error')
      setUrlMessage('Network error')
    }
  }

  const processQueue = useCallback(async (items: QueueItem[]) => {
    if (processingRef.current) return
    processingRef.current = true

    for (const item of items) {
      setQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'processing' } : i))

      const form = new FormData()
      form.append('file', item.file)
      try {
        const res = await fetch('/api/ingest/file', { method: 'POST', body: form })
        const data = await res.json()
        if (res.ok && data.duplicate) {
          setQueue(q => q.map(i => i.id === item.id
            ? { ...i, status: 'duplicate' }
            : i))
        } else if (res.ok) {
          setQueue(q => q.map(i => i.id === item.id
            ? { ...i, status: 'done', message: `${data.chunkCount} chunks` }
            : i))
          fetchDocs()
        } else {
          setQueue(q => q.map(i => i.id === item.id
            ? { ...i, status: 'error', message: data.error ?? 'Unknown error' }
            : i))
        }
      } catch {
        setQueue(q => q.map(i => i.id === item.id
          ? { ...i, status: 'error', message: 'Network error' }
          : i))
      }
    }

    processingRef.current = false
  }, [fetchDocs])

  function enqueueFiles(files: File[]) {
    const newItems: QueueItem[] = files.map(file => ({
      id: `${Date.now()}-${Math.random()}`,
      file,
      status: 'queued',
    }))
    setQueue(q => [...q, ...newItems])
  }

  // Kick off processing whenever new queued items appear
  useEffect(() => {
    const pending = queue.filter(i => i.status === 'queued')
    if (pending.length > 0 && !processingRef.current) {
      processQueue(pending)
    }
  }, [queue, processQueue])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) enqueueFiles(files)
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length) enqueueFiles(files)
    e.target.value = ''
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <main className="min-h-screen" style={{ background: '#f5f4f0', color: '#1a1a18' }}>
      <div className="max-w-2xl mx-auto px-6 py-16">

        {/* Header */}
        <div className="mb-14">
          <h1 className="text-4xl font-medium tracking-tight" style={{ color: '#1a1a18', fontFamily: 'var(--font-serif)' }}>Pantani</h1>
          <p className="text-sm mt-2" style={{ color: '#6b6b63' }}>Libro di corsa</p>
        </div>

        {/* URL intake */}
        <section className="mb-8">
          <h2 className="text-xs uppercase tracking-widest mb-3" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>Link</h2>
          <form onSubmit={submitUrl} className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="flex-1 rounded px-3 py-2 text-sm focus:outline-none"
              style={{ background: '#eceae4', border: '1px solid #d8d6ce', color: '#1a1a18' }}
            />
            <button
              type="submit"
              disabled={urlStatus === 'loading'}
              className="text-sm px-4 py-2 rounded transition-colors disabled:opacity-40"
              style={{ background: '#1a1a18', color: '#f5f4f0' }}
            >
              {urlStatus === 'loading' ? '...' : 'Ingest'}
            </button>
          </form>
          {urlMessage && (
            <p className={`text-xs mt-2 ${urlStatus === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
              {urlMessage}
            </p>
          )}
        </section>

        {/* File drop */}
        <section className="mb-10">
          <h2 className="text-xs uppercase tracking-widest mb-3" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>File</h2>
          <label
            htmlFor="file-input"
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            className="block rounded-lg p-8 text-center cursor-pointer transition-colors"
            style={{
              border: `2px dashed ${isDragging ? '#9a9a8e' : '#d8d6ce'}`,
              background: isDragging ? '#eceae4' : 'transparent',
            }}
          >
            <input
              id="file-input"
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.csv"
              onChange={onFileInput}
              multiple
              className="sr-only"
            />
            <p className="text-sm" style={{ color: '#6b6b63' }}>Drop files here or click to browse</p>
            <p className="text-xs mt-1" style={{ color: '#9a9a8e' }}>PDF · DOCX · TXT · MD</p>
          </label>

          {queue.length > 0 && (
            <ul className="mt-3 space-y-1">
              {queue.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-xs rounded px-3 py-2" style={{ background: '#eceae4', border: '1px solid #d8d6ce' }}>
                  <span className="flex-1 truncate" style={{ color: '#4a4a42' }}>{item.file.name}</span>
                  {item.status === 'queued' && (
                    <span style={{ color: '#9a9a8e' }}>In coda</span>
                  )}
                  {item.status === 'processing' && (
                    <span style={{ color: '#6b6b63' }}>Elaborazione...</span>
                  )}
                  {item.status === 'duplicate' && (
                    <span style={{ color: '#9a9a8e' }}>Gia presente</span>
                  )}
                  {item.status === 'done' && (
                    <span className="text-emerald-700">{item.message}</span>
                  )}
                  {item.status === 'error' && (
                    <span className="text-red-600">{item.message}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Email */}
        <section className="mb-14 rounded-lg p-5" style={{ background: '#eceae4', border: '1px solid #d8d6ce' }}>
          <h2 className="text-xs uppercase tracking-widest mb-3" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>Email</h2>
          <p className="text-sm" style={{ color: '#4a4a42' }}>
            Forward any email to your inbound address and it will be added to the knowledge store automatically.
          </p>
          <div className="mt-3 rounded px-3 py-2 text-sm font-mono" style={{ background: '#f5f4f0', color: '#4a4a42' }}>
            {process.env.NEXT_PUBLIC_INBOUND_EMAIL ?? 'pantani@your-domain.com'}
          </div>
          <p className="text-xs mt-2" style={{ color: '#9a9a8e' }}>
            Configure your inbound email webhook to POST to <code>/api/ingest/email</code>
          </p>
        </section>

        {/* Document list */}
        <section>
          <h2 className="text-xs uppercase tracking-widest mb-4" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>
            Knowledge store
            {!docsLoading && (
              <span className="ml-2 normal-case" style={{ color: '#b8b8ae' }}>
                {documents.length} document{documents.length !== 1 ? 's' : ''}
              </span>
            )}
          </h2>

          {docsLoading ? (
            <p className="text-sm" style={{ color: '#9a9a8e' }}>Loading...</p>
          ) : documents.length === 0 ? (
            <p className="text-sm" style={{ color: '#9a9a8e' }}>No documents ingested yet.</p>
          ) : (
            <ul className="space-y-3">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="rounded-lg px-4 py-4 text-sm"
                  style={{ background: '#eceae4', border: '1px solid #d8d6ce' }}
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 w-4 shrink-0 text-xs" style={{ color: '#9a9a8e' }} title={SOURCE_LABELS[doc.source_type]}>
                      {SOURCE_ICONS[doc.source_type]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-medium" style={{ color: '#1a1a18' }}>
                        {doc.title ?? doc.source_ref ?? '(untitled)'}
                      </p>
                      {doc.source_type === 'email' && doc.source_from && (
                        <p className="text-xs truncate mt-0.5" style={{ color: '#9a9a8e' }}>{doc.source_from}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs" style={{ color: '#9a9a8e' }}>{formatDate(doc.created_at)}</p>
                      {doc.token_count && (
                        <p className="text-xs mt-0.5" style={{ color: '#b8b8ae' }}>~{doc.token_count.toLocaleString()} tok</p>
                      )}
                    </div>
                  </div>
                  {doc.summary && (
                    <p className="text-xs mt-3 ml-7 leading-relaxed" style={{ color: '#6b6b63' }}>{doc.summary}</p>
                  )}
                  {doc.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2 ml-7">
                      {doc.tags.map((tag) => (
                        <span
                          key={tag}
                          className={`text-xs px-2 py-0.5 rounded-full ${TAG_COLOURS[tag] ?? 'bg-stone-100 text-stone-600'}`}
                        >
                          {tag.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}
