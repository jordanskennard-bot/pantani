import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { embedQuery } from '@/lib/embeddings'

export const runtime = 'nodejs'

// GET /api/knowledge — list recent documents
export async function GET() {
  const { data, error } = await supabase
    .from('documents')
    .select('id, created_at, source_type, source_ref, source_from, title, token_count, summary, tags, metadata')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ documents: data })
}

// DELETE /api/knowledge?id=... — remove a document and its chunks (cascade)
export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await supabase.from('documents').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

// POST /api/knowledge/search — semantic search over the knowledge store
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const query: string = body?.query ?? ''

  if (!query.trim()) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  const k: number = Math.min(body?.k ?? 8, 20)

  let embedding: number[]
  try {
    embedding = await embedQuery(query)
  } catch (err) {
    console.error('Embedding error:', err)
    return NextResponse.json({ error: 'Failed to embed query' }, { status: 500 })
  }

  const { data, error } = await supabase.rpc('search_knowledge', {
    query_embedding: JSON.stringify(embedding),
    match_count: k,
    filter_source_type: body?.sourceType ?? null,
    filter_tags: body?.tags ?? null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ results: data })
}
