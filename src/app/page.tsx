'use client'

import { useState, useCallback, useEffect } from 'react'

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
  competitive_intel:  'bg-rose-900/50 text-rose-300',
  programmatic:       'bg-blue-900/50 text-blue-300',
  cpm_benchmarks:     'bg-amber-900/50 text-amber-300',
  attribution:        'bg-purple-900/50 text-purple-300',
  audience:           'bg-teal-900/50 text-teal-300',
  merchant_profile:   'bg-green-900/50 text-green-300',
  category_knowledge: 'bg-orange-900/50 text-orange-300',
  platform_intel:     'bg-sky-900/50 text-sky-300',
  regulation:         'bg-zinc-700/50 text-zinc-400',
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

  const [fileStatus, setFileStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [fileMessage, setFileMessage] = useState('')
  const [isDragging, setIsDragging] = useState(false)

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
        setUrlMessage(`Ingested "${data.title}" — ${data.chunkCount} chunks`)
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

  async function uploadFile(file: File) {
    setFileStatus('loading')
    setFileMessage('')
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch('/api/ingest/file', { method: 'POST', body: form })
      const data = await res.json()
      if (res.ok) {
        setFileStatus('ok')
        setFileMessage(`Ingested "${file.name}" — ${data.chunkCount} chunks`)
        fetchDocs()
      } else {
        setFileStatus('error')
        setFileMessage(data.error ?? 'Unknown error')
      }
    } catch {
      setFileStatus('error')
      setFileMessage('Network error')
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) uploadFile(file)
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) uploadFile(file)
    e.target.value = ''
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      <div className="max-w-3xl mx-auto px-6 py-12">

        {/* Header */}
        <div className="mb-12">
          <h1 className="text-2xl font-bold tracking-tight text-white">Pantani</h1>
          <p className="text-zinc-500 text-sm mt-1">Libro di corsa — knowledge intake</p>
        </div>

        {/* URL intake */}
        <section className="mb-8">
          <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-3">Link</h2>
          <form onSubmit={submitUrl} className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
            />
            <button
              type="submit"
              disabled={urlStatus === 'loading'}
              className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 text-sm px-4 py-2 rounded transition-colors"
            >
              {urlStatus === 'loading' ? '...' : 'Ingest'}
            </button>
          </form>
          {urlMessage && (
            <p className={`text-xs mt-2 ${urlStatus === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
              {urlMessage}
            </p>
          )}
        </section>

        {/* File drop */}
        <section className="mb-12">
          <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-3">File</h2>
          <label
            htmlFor="file-input"
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragging
                ? 'border-zinc-400 bg-zinc-900'
                : 'border-zinc-800 hover:border-zinc-700'
            }`}
          >
            <input
              id="file-input"
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.csv"
              onChange={onFileInput}
              className="sr-only"
            />
            {fileStatus === 'loading' ? (
              <p className="text-zinc-500 text-sm">Processing...</p>
            ) : (
              <>
                <p className="text-zinc-400 text-sm">Drop a file here or click to browse</p>
                <p className="text-zinc-600 text-xs mt-1">PDF · DOCX · TXT · MD</p>
              </>
            )}
          </label>
          {fileMessage && (
            <p className={`text-xs mt-2 ${fileStatus === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
              {fileMessage}
            </p>
          )}
        </section>

        {/* Email forwarding instructions */}
        <section className="mb-12 bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-3">Email</h2>
          <p className="text-zinc-400 text-sm">
            Forward any email to your inbound address and it will be added to the knowledge store automatically.
          </p>
          <div className="mt-3 bg-zinc-950 rounded px-3 py-2 text-sm text-zinc-300 font-mono">
            {process.env.NEXT_PUBLIC_INBOUND_EMAIL ?? 'pantani@your-domain.com'}
          </div>
          <p className="text-zinc-600 text-xs mt-2">
            Configure your inbound email webhook to POST to <code>/api/ingest/email</code>
          </p>
        </section>

        {/* Document list */}
        <section>
          <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-3">
            Knowledge store
            {!docsLoading && (
              <span className="ml-2 text-zinc-600 normal-case">
                {documents.length} document{documents.length !== 1 ? 's' : ''}
              </span>
            )}
          </h2>

          {docsLoading ? (
            <p className="text-zinc-600 text-sm">Loading...</p>
          ) : documents.length === 0 ? (
            <p className="text-zinc-600 text-sm">No documents ingested yet.</p>
          ) : (
            <ul className="space-y-2">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="bg-zinc-900 rounded px-4 py-3 text-sm"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-zinc-600 mt-0.5 w-4 shrink-0" title={SOURCE_LABELS[doc.source_type]}>
                      {SOURCE_ICONS[doc.source_type]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-zinc-200 truncate">
                        {doc.title ?? doc.source_ref ?? '(untitled)'}
                      </p>
                      {doc.source_type === 'email' && doc.source_from && (
                        <p className="text-zinc-600 text-xs truncate">{doc.source_from}</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-zinc-600 text-xs">{formatDate(doc.created_at)}</p>
                      {doc.token_count && (
                        <p className="text-zinc-700 text-xs">~{doc.token_count.toLocaleString()} tok</p>
                      )}
                    </div>
                  </div>
                  {doc.summary && (
                    <p className="text-zinc-500 text-xs mt-2 ml-7 leading-relaxed">{doc.summary}</p>
                  )}
                  {doc.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2 ml-7">
                      {doc.tags.map((tag) => (
                        <span
                          key={tag}
                          className={`text-xs px-2 py-0.5 rounded-full ${TAG_COLOURS[tag] ?? 'bg-zinc-800 text-zinc-400'}`}
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
