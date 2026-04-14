import { NextRequest, NextResponse } from 'next/server'
import { ingest } from '@/lib/ingest'
import { extractPdf, extractDocx, extractPlainText } from '@/lib/extract'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20 MB

export async function POST(request: NextRequest) {
  const formData = await request.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'File exceeds 20 MB limit' }, { status: 413 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const name = file.name
  const ext = name.split('.').pop()?.toLowerCase() ?? ''

  let text: string
  try {
    if (ext === 'pdf') {
      text = await extractPdf(buffer)
    } else if (ext === 'docx') {
      text = await extractDocx(buffer)
    } else if (['txt', 'md', 'markdown', 'csv'].includes(ext)) {
      text = extractPlainText(buffer)
    } else {
      return NextResponse.json(
        { error: `Unsupported file type: .${ext}` },
        { status: 415 },
      )
    }
  } catch (err) {
    console.error('File extraction error:', err)
    return NextResponse.json({ error: 'Failed to extract text from file' }, { status: 422 })
  }

  if (!text.trim()) {
    return NextResponse.json({ error: 'No text could be extracted from file' }, { status: 422 })
  }

  try {
    const result = await ingest({
      sourceType: 'file',
      sourceRef: name,
      title: name.replace(/\.[^.]+$/, ''),
      text,
      metadata: { fileSize: file.size, mimeType: file.type },
    })

    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Ingest error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
