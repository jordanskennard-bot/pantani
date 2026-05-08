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
  source_type: 'email' | 'file' | 'url' | 'youtube'
  source_ref: string | null
  source_from: string | null
  title: string | null
  token_count: number | null
  summary: string | null
  tags: string[]
}

// All tags share the paper-tone treatment. Rosa is reserved for emphasis,
// not category indicators.
const TAG_CLASS = 'pill'

const SOURCE_LABELS: Record<string, string> = {
  email: 'Email',
  file: 'File',
  url: 'Link',
  youtube: 'YouTube',
}

export default function Home() {
  const [question, setQuestion] = useState('')
  const [askStatus, setAskStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [answer, setAnswer] = useState('')
  const [sources, setSources] = useState<Array<{ title: string; source_type: string; source_ref: string }>>([])

  async function submitQuestion(e: React.FormEvent) {
    e.preventDefault()
    if (!question.trim()) return
    setAskStatus('loading')
    setAnswer('')
    setSources([])
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      const data = await res.json()
      if (res.ok) {
        setAnswer(data.answer)
        setSources(data.sources ?? [])
        setAskStatus('done')
      } else {
        setAnswer(data.error ?? 'Unknown error')
        setAskStatus('error')
      }
    } catch {
      setAnswer('Network error')
      setAskStatus('error')
    }
  }

  const [url, setUrl] = useState('')
  const [urlStatus, setUrlStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [urlMessage, setUrlMessage] = useState('')

  const [ytChannel, setYtChannel] = useState('')
  const [ytStatus, setYtStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [ytMessage, setYtMessage] = useState('')
  const [ytResults, setYtResults] = useState<Array<{ videoId: string; title: string; status: string; error?: string }>>([])


  const [queue, setQueue] = useState<QueueItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const processingRef = useRef(false)

  const [documents, setDocuments] = useState<Document[]>([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function deleteDoc(id: string) {
    setDeletingId(id)
    const res = await fetch(`/api/knowledge?id=${id}`, { method: 'DELETE' })
    if (res.ok) {
      setDocuments(d => d.filter(doc => doc.id !== id))
    }
    setDeletingId(null)
  }

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

  async function runYouTubeIngest(channel: string, accumulated: typeof ytResults) {
    const res = await fetch('/api/ingest/youtube-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    })
    const data = await res.json()
    if (!res.ok) {
      setYtStatus('error')
      setYtMessage(data.error ?? 'Unknown error')
      return
    }

    const allResults = [...accumulated, ...(data.results ?? [])]
    const totals = allResults.reduce(
      (acc, r) => { acc[r.status as keyof typeof acc] = (acc[r.status as keyof typeof acc] ?? 0) + 1; return acc },
      { ingested: 0, skipped: 0, no_transcript: 0, error: 0 },
    )
    const label = data.channelTitle ?? 'Video'
    setYtResults(allResults)
    if (totals.ingested > 0) fetchDocs()

    if (data.hasMore) {
      setYtMessage(`${label}: ${totals.ingested} ingested so far, continuing.`)
      setYtStatus('loading')
      await new Promise(r => setTimeout(r, 3_000))
      await runYouTubeIngest(channel, allResults)
    } else {
      setYtMessage(`${label}: ${totals.ingested} ingested, ${totals.skipped} skipped, ${totals.no_transcript} no transcript, ${totals.error} errors`)
      setYtStatus(totals.ingested > 0 || totals.skipped > 0 ? 'ok' : 'error')
      if (totals.ingested > 0) setYtChannel('')
    }
  }

  async function submitYouTubeChannel(e: React.FormEvent) {
    e.preventDefault()
    if (!ytChannel.trim()) return
    setYtStatus('loading')
    setYtMessage('Starting...')
    setYtResults([])
    try {
      await runYouTubeIngest(ytChannel.trim(), [])
    } catch {
      setYtStatus('error')
      setYtMessage('Network error')
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

      // Pause between documents to avoid hitting Haiku rate limits (50 RPM)
      await new Promise(r => setTimeout(r, 3000))
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
    <main className="min-h-screen">
      <div className="max-w-2xl mx-auto px-6 py-16">

        {/* Masthead */}
        <header className="mb-12">
          <div className="flex items-center gap-2 mb-3">
            <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ width: 30, height: 24, flexShrink: 0 }}>
              <g transform="translate(16, 24)">
                <line x1="120" y1="10" x2="120" y2="16" stroke="var(--rosa)" strokeWidth="1.5" strokeLinecap="butt" />
                <path d="M 0 110 C 14 109, 22 108, 32 106 C 46 103, 60 99, 72 92 C 86 84, 96 70, 104 56 C 112 42, 116 30, 120 18 L 124 30 C 130 46, 138 64, 148 80 C 156 92, 162 100, 168 110" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit="10" fill="none" />
                <line x1="0" y1="110" x2="168" y2="110" stroke="var(--ink)" strokeWidth="1.25" />
              </g>
            </svg>
            <span className="label">Passo</span>
          </div>
          <h1 className="display" style={{ fontWeight: 'var(--w-regular)' }}>Pantani</h1>
          <p className="body-sm mt-2" style={{ color: 'var(--ink-3)', fontStyle: 'italic', fontFamily: 'var(--serif)' }}>Libro di corsa</p>
          <hr className="rule" style={{ marginTop: 'var(--s-5)', marginBottom: 0 }} />
        </header>

        {/* Ask Pantani */}
        <section className="mb-12">
          <h2 className="label mb-3">Chiedi</h2>
          <form onSubmit={submitQuestion} className="flex gap-2">
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="Ask Pantani anything"
              className="input flex-1"
            />
            <button
              type="submit"
              disabled={askStatus === 'loading'}
              className="btn"
            >
              {askStatus === 'loading' ? '...' : 'Ask'}
            </button>
          </form>

          {(answer || askStatus === 'loading') && (
            <div className="card mt-4">
              {askStatus === 'loading' ? (
                <p className="body-sm" style={{ color: 'var(--ink-3)' }}>Thinking...</p>
              ) : (
                <>
                  <p
                    className="body-sm"
                    style={{
                      whiteSpace: 'pre-wrap',
                      color: askStatus === 'error' ? 'var(--rosa)' : 'var(--ink)',
                      lineHeight: 1.6,
                    }}
                  >
                    {answer}
                  </p>
                  {sources.length > 0 && (
                    <div className="mt-4 pt-3" style={{ borderTop: 'var(--rule-hair)' }}>
                      <p className="label mb-2">Sources</p>
                      <ul className="space-y-1">
                        {sources.map((s, i) => (
                          <li key={i} className="flex items-baseline gap-3 body-sm" style={{ color: 'var(--ink-3)' }}>
                            <span className="label-sm" style={{ minWidth: 56, color: 'var(--ink-4)' }}>
                              {SOURCE_LABELS[s.source_type] ?? s.source_type}
                            </span>
                            {s.source_ref && (s.source_type === 'url' || s.source_type === 'youtube') ? (
                              <a
                                href={s.source_ref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="truncate link-bare"
                                style={{ color: 'var(--ink-2)', borderBottom: '1px solid var(--paper-rule)' }}
                              >
                                {s.title}
                              </a>
                            ) : (
                              <span className="truncate">{s.title}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {/* URL intake */}
        <section className="mb-10">
          <h2 className="label mb-3">Link</h2>
          <form onSubmit={submitUrl} className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
              className="input flex-1"
            />
            <button
              type="submit"
              disabled={urlStatus === 'loading'}
              className="btn"
            >
              {urlStatus === 'loading' ? '...' : 'Ingest'}
            </button>
          </form>
          {urlMessage && (
            <p className="body-sm mt-2" style={{ color: urlStatus === 'ok' ? 'var(--forest)' : 'var(--rosa)' }}>
              {urlMessage}
            </p>
          )}
        </section>

        {/* YouTube channel */}
        <section className="mb-10">
          <h2 className="label mb-3">YouTube</h2>
          <form onSubmit={submitYouTubeChannel} className="flex gap-2">
            <input
              type="text"
              value={ytChannel}
              onChange={(e) => setYtChannel(e.target.value)}
              placeholder="https://www.youtube.com/@channel or @handle"
              className="input flex-1"
            />
            <button
              type="submit"
              disabled={ytStatus === 'loading'}
              className="btn"
            >
              {ytStatus === 'loading' ? '...' : 'Ingest'}
            </button>
          </form>
          {ytMessage && (
            <p className="body-sm mt-2" style={{ color: ytStatus === 'ok' ? 'var(--forest)' : 'var(--rosa)' }}>
              {ytMessage}
            </p>
          )}
          {ytResults.length > 0 && (
            <ul className="mt-2 space-y-0.5 max-h-48 overflow-y-auto">
              {ytResults.map((r) => (
                <li key={r.videoId} className="caption flex gap-3" style={{ color: 'var(--ink-3)' }}>
                  <span
                    className="label-sm shrink-0"
                    style={{
                      minWidth: 48,
                      color:
                        r.status === 'ingested' ? 'var(--forest)'
                        : r.status === 'error' ? 'var(--rosa)'
                        : 'var(--ink-4)',
                    }}
                  >
                    {r.status === 'ingested' ? 'IN' : r.status === 'skipped' ? 'SKIP' : r.status === 'no_transcript' ? 'NONE' : 'ERR'}
                  </span>
                  <span className="truncate" title={r.error ?? r.title}>{r.title}</span>
                  {r.error && (
                    <span className="shrink-0 truncate max-w-xs" title={r.error} style={{ color: 'var(--rosa)' }}>
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="caption mt-3" style={{ color: 'var(--ink-4)' }}>
            Ingests all video transcripts. New videos are picked up automatically via{' '}
            <code style={{ fontFamily: 'var(--sans)', color: 'var(--ink-2)' }}>/api/poll-youtube</code>.
          </p>
        </section>

        {/* File drop */}
        <section className="mb-10">
          <h2 className="label mb-3">File</h2>
          <label
            htmlFor="file-input"
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            className="block p-8 text-center cursor-pointer transition-colors"
            style={{
              border: `1px dashed ${isDragging ? 'var(--ink)' : 'var(--paper-rule)'}`,
              background: isDragging ? 'var(--paper-2)' : 'transparent',
              borderRadius: 'var(--r-2)',
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
            <p className="body-sm" style={{ color: 'var(--ink-2)' }}>Drop files here or click to browse</p>
            <p className="label-sm mt-2">PDF · DOCX · TXT · MD</p>
          </label>

          {queue.length > 0 && (
            <ul className="mt-3 space-y-1">
              {queue.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 body-sm px-3 py-2"
                  style={{
                    background: 'var(--paper-2)',
                    border: 'var(--rule-hair)',
                    borderRadius: 'var(--r-1)',
                  }}
                >
                  <span className="flex-1 truncate" style={{ color: 'var(--ink-2)' }}>{item.file.name}</span>
                  {item.status === 'queued' && (
                    <span className="label-sm">In coda</span>
                  )}
                  {item.status === 'processing' && (
                    <span className="label-sm" style={{ color: 'var(--ink-3)' }}>Elaborazione</span>
                  )}
                  {item.status === 'duplicate' && (
                    <span className="label-sm">Già presente</span>
                  )}
                  {item.status === 'done' && (
                    <span className="label-sm" style={{ color: 'var(--forest)' }}>{item.message}</span>
                  )}
                  {item.status === 'error' && (
                    <span className="label-sm" style={{ color: 'var(--rosa)' }}>{item.message}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Email */}
        <section className="mb-12">
          <h2 className="label mb-3">Email</h2>
          <div className="card">
            <p className="body-sm" style={{ color: 'var(--ink-2)' }}>
              Forward any email to the inbound address and it will be added to the knowledge store automatically.
            </p>
            <div
              className="mt-3 px-3 py-2 body-sm"
              style={{
                background: 'var(--paper)',
                border: 'var(--rule-hair)',
                borderRadius: 'var(--r-1)',
                fontFamily: 'var(--sans)',
                color: 'var(--ink)',
              }}
            >
              {process.env.NEXT_PUBLIC_INBOUND_EMAIL ?? 'pantani@your-domain.com'}
            </div>
          </div>
        </section>

        {/* Document list */}
        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="label">Knowledge store</h2>
            {!docsLoading && (
              <span className="label-sm">
                {documents.length} document{documents.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <hr className="rule" style={{ marginTop: 0, marginBottom: 'var(--s-4)' }} />

          {docsLoading ? (
            <p className="body-sm" style={{ color: 'var(--ink-3)' }}>Loading...</p>
          ) : documents.length === 0 ? (
            <p className="body-sm" style={{ color: 'var(--ink-3)' }}>No documents ingested yet.</p>
          ) : (
            <ul className="space-y-3">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="px-4 py-4 body-sm"
                  style={{
                    background: 'var(--paper-3)',
                    border: 'var(--rule-hair)',
                    borderRadius: 'var(--r-2)',
                  }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="label-sm shrink-0"
                      style={{ minWidth: 56, marginTop: 4, color: 'var(--ink-4)' }}
                      title={SOURCE_LABELS[doc.source_type]}
                    >
                      {SOURCE_LABELS[doc.source_type] ?? doc.source_type}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="truncate" style={{ color: 'var(--ink)', fontWeight: 'var(--w-medium)' }}>
                        {doc.title ?? doc.source_ref ?? '(untitled)'}
                      </p>
                      {doc.source_type === 'email' && doc.source_from && (
                        <p className="caption truncate mt-0.5" style={{ color: 'var(--ink-3)' }}>{doc.source_from}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0 flex items-start gap-3">
                      <div>
                        <p className="label-sm" style={{ color: 'var(--ink-4)' }}>{formatDate(doc.created_at)}</p>
                        {doc.token_count != null && (
                          <p className="label-sm mt-0.5" style={{ color: 'var(--ink-4)' }}>~{doc.token_count.toLocaleString()} tok</p>
                        )}
                      </div>
                      <button
                        onClick={() => deleteDoc(doc.id)}
                        disabled={deletingId === doc.id}
                        className="leading-none transition-colors disabled:opacity-40"
                        style={{ color: 'var(--ink-4)', fontSize: '14px', marginTop: 2 }}
                        onMouseEnter={e => (e.currentTarget.style.color = 'var(--rosa)')}
                        onMouseLeave={e => (e.currentTarget.style.color = 'var(--ink-4)')}
                        title="Remove document"
                        aria-label="Remove document"
                      >
                        {deletingId === doc.id ? '...' : '×'}
                      </button>
                    </div>
                  </div>
                  {doc.summary && (
                    <p
                      className="caption mt-3 leading-relaxed"
                      style={{ marginLeft: 68, color: 'var(--ink-2)' }}
                    >
                      {doc.summary}
                    </p>
                  )}
                  {doc.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2" style={{ marginLeft: 68 }}>
                      {doc.tags.map((tag) => (
                        <span key={tag} className={TAG_CLASS}>
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
