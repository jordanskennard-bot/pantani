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
  adcp:               'bg-violet-100 text-violet-700',
  artf:               'bg-cyan-100 text-cyan-700',
  agentic:            'bg-indigo-100 text-indigo-700',
  new_customer:       'bg-lime-100 text-lime-700',
  incrementality:     'bg-yellow-100 text-yellow-700',
  shopify:            'bg-emerald-100 text-emerald-700',
}

const SOURCE_ICONS: Record<string, string> = {
  email: '✉',
  file: '▣',
  url: '⬡',
  youtube: '▶',
}

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
      setYtMessage(`${label}: ${totals.ingested} ingested so far — continuing...`)
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
    <main className="min-h-screen" style={{ background: '#f5f4f0', color: '#1a1a18' }}>
      <div className="max-w-2xl mx-auto px-6 py-16">

        {/* Header */}
        <div className="mb-14">
          <div className="flex items-center gap-2 mb-3">
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ width: 20, height: 20, flexShrink: 0 }}>
              <path d="M4 22 L16 10 L28 22" stroke="#1a1a18" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-xs uppercase tracking-widest" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>Passo</span>
          </div>
          <h1 className="text-4xl font-medium tracking-tight" style={{ color: '#1a1a18', fontFamily: 'var(--font-serif)' }}>Pantani</h1>
          <p className="text-sm mt-2" style={{ color: '#6b6b63' }}>Libro di corsa</p>
        </div>

        {/* Ask Pantani */}
        <section className="mb-14">
          <h2 className="text-xs uppercase tracking-widest mb-3" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>Chiedi</h2>
          <form onSubmit={submitQuestion} className="flex gap-2">
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="Ask Pantani anything..."
              className="flex-1 rounded px-3 py-2 text-sm focus:outline-none"
              style={{ background: '#eceae4', border: '1px solid #d8d6ce', color: '#1a1a18' }}
            />
            <button
              type="submit"
              disabled={askStatus === 'loading'}
              className="text-sm px-4 py-2 rounded transition-colors disabled:opacity-40"
              style={{ background: '#1a1a18', color: '#f5f4f0' }}
            >
              {askStatus === 'loading' ? '...' : 'Ask'}
            </button>
          </form>

          {(answer || askStatus === 'loading') && (
            <div className="mt-4 rounded-lg px-5 py-4" style={{ background: '#eceae4', border: '1px solid #d8d6ce' }}>
              {askStatus === 'loading' ? (
                <p className="text-sm" style={{ color: '#9a9a8e' }}>Thinking...</p>
              ) : (
                <>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: askStatus === 'error' ? '#dc2626' : '#1a1a18' }}>
                    {answer}
                  </p>
                  {sources.length > 0 && (
                    <div className="mt-4 pt-3" style={{ borderTop: '1px solid #d8d6ce' }}>
                      <p className="text-xs mb-2" style={{ color: '#9a9a8e' }}>Sources</p>
                      <ul className="space-y-1">
                        {sources.map((s, i) => (
                          <li key={i} className="flex items-center gap-2 text-xs" style={{ color: '#6b6b63' }}>
                            <span style={{ color: '#9a9a8e' }}>{SOURCE_ICONS[s.source_type] ?? '▣'}</span>
                            {s.source_ref && (s.source_type === 'url' || s.source_type === 'youtube') ? (
                              <a
                                href={s.source_ref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="truncate hover:underline"
                                style={{ color: '#4a4a42' }}
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

        {/* YouTube channel */}
        <section className="mb-8">
          <h2 className="text-xs uppercase tracking-widest mb-3" style={{ color: '#9a9a8e', letterSpacing: '0.12em' }}>YouTube</h2>
          <form onSubmit={submitYouTubeChannel} className="flex gap-2">
            <input
              type="text"
              value={ytChannel}
              onChange={(e) => setYtChannel(e.target.value)}
              placeholder="https://www.youtube.com/@channel or @handle"
              className="flex-1 rounded px-3 py-2 text-sm focus:outline-none"
              style={{ background: '#eceae4', border: '1px solid #d8d6ce', color: '#1a1a18' }}
            />
            <button
              type="submit"
              disabled={ytStatus === 'loading'}
              className="text-sm px-4 py-2 rounded transition-colors disabled:opacity-40"
              style={{ background: '#1a1a18', color: '#f5f4f0' }}
            >
              {ytStatus === 'loading' ? '...' : 'Ingest'}
            </button>
          </form>
          {ytMessage && (
            <p className={`text-xs mt-2 ${ytStatus === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>
              {ytMessage}
            </p>
          )}
          {ytResults.length > 0 && (
            <ul className="mt-2 space-y-0.5 max-h-48 overflow-y-auto">
              {ytResults.map((r) => (
                <li key={r.videoId} className="text-xs flex gap-2" style={{ color: '#6b6b63' }}>
                  <span className="shrink-0" style={{
                    color: r.status === 'ingested' ? '#047857'
                         : r.status === 'skipped' ? '#9a9a8e'
                         : '#dc2626'
                  }}>
                    {r.status === 'ingested' ? '▸' : r.status === 'skipped' ? '·' : '×'}
                  </span>
                  <span className="truncate" title={r.error ?? r.title}>{r.title}</span>
                  {r.error && (
                    <span className="shrink-0 truncate max-w-xs" style={{ color: '#dc2626' }} title={r.error}>
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs mt-2" style={{ color: '#9a9a8e' }}>
            Ingests all video transcripts. New videos are picked up automatically via <code>/api/poll-youtube</code>.
          </p>
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
                    <div className="text-right shrink-0 flex items-start gap-3">
                      <div>
                        <p className="text-xs" style={{ color: '#9a9a8e' }}>{formatDate(doc.created_at)}</p>
                        {doc.token_count && (
                          <p className="text-xs mt-0.5" style={{ color: '#b8b8ae' }}>~{doc.token_count.toLocaleString()} tok</p>
                        )}
                      </div>
                      <button
                        onClick={() => deleteDoc(doc.id)}
                        disabled={deletingId === doc.id}
                        className="text-xs leading-none mt-0.5 transition-colors disabled:opacity-40"
                        style={{ color: '#b8b8ae' }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#c0392b')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#b8b8ae')}
                        title="Remove document"
                      >
                        {deletingId === doc.id ? '...' : '×'}
                      </button>
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
                          className={`text-xs px-2 py-0.5 rounded ${TAG_COLOURS[tag] ?? 'bg-stone-100 text-stone-600'}`}
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
