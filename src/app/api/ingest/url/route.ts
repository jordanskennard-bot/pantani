import { NextRequest, NextResponse } from 'next/server'
import { ingest } from '@/lib/ingest'
import { extractUrl } from '@/lib/extract'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const url: string | undefined = body?.url

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  // Basic URL validation
  let parsed: URL
  try {
    parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  let title: string
  let text: string
  try {
    ;({ title, text } = await extractUrl(url))
  } catch (err) {
    console.error('URL extraction error:', err)
    return NextResponse.json({ error: 'Failed to fetch or extract content from URL' }, { status: 422 })
  }

  if (!text.trim()) {
    return NextResponse.json({ error: 'No text could be extracted from URL' }, { status: 422 })
  }

  try {
    const result = await ingest({
      sourceType: 'url',
      sourceRef: url,
      title,
      text,
      metadata: { domain: parsed.hostname },
    })

    return NextResponse.json({ success: true, title, ...result })
  } catch (err) {
    console.error('Ingest error:', err)
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 })
  }
}
