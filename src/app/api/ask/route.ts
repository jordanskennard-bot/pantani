import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { embedQuery } from '@/lib/embeddings'
import { getSupabase } from '@/lib/supabase'

export const runtime = 'nodejs'

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

type Chunk = {
  chunk_id: string
  document_id: string
  source_type: string
  source_ref: string
  title: string
  summary: string
  key_insights: string[]
  tags: string[]
  content: string
  context_prefix: string
  similarity: number
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  const question: string = body?.question ?? ''

  if (!question.trim()) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 })
  }

  // Embed the question
  let embedding: number[]
  try {
    embedding = await embedQuery(question)
  } catch {
    return NextResponse.json({ error: 'Failed to embed question' }, { status: 500 })
  }

  // Retrieve top chunks
  const { data: chunks, error } = await getSupabase().rpc('search_knowledge', {
    query_embedding: JSON.stringify(embedding),
    match_count: 15,
    filter_source_type: null,
    filter_tags: null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!chunks || chunks.length === 0) {
    return NextResponse.json({
      answer: 'No relevant knowledge found. Try ingesting some documents first.',
      sources: [],
    })
  }

  // Build document-level context block — deduplicate by document_id, show summary + key insights
  const seenDocIds = new Set<string>()
  const docContextParts: string[] = []
  for (const c of chunks as Chunk[]) {
    if (seenDocIds.has(c.document_id)) continue
    seenDocIds.add(c.document_id)
    const name = c.title ?? c.source_ref ?? 'Untitled'
    const insights =
      Array.isArray(c.key_insights) && c.key_insights.length > 0
        ? '\nKey insights:\n' + c.key_insights.map((i: string) => `• ${i}`).join('\n')
        : ''
    docContextParts.push(`${name}\n${c.summary}${insights}`)
  }
  const docContext = docContextParts.join('\n\n')

  // Build chunk-level context block — specific passages with insight prefix
  const chunkContext = (chunks as Chunk[])
    .map((c, i) => {
      const name = c.title ?? c.source_ref ?? 'Untitled'
      const prefix = c.context_prefix ? `${c.context_prefix}\n` : ''
      return `[${i + 1}] ${name} (${c.source_type})\n${prefix}${c.content}`
    })
    .join('\n\n---\n\n')

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are Pantani — the knowledge layer of Passo, an autonomous programmatic media agency for Shopify DTC merchants. You answer questions precisely, drawing on extracted document insights and specific passages. Passo's agents (Galibier, Gavia, Izoard, Stelvio) rely on your answers to make media decisions, so accuracy and specificity matter more than breadth.

DOCUMENT SUMMARIES AND KEY INSIGHTS:
${docContext}

RELEVANT PASSAGES:
${chunkContext}

---

Question: ${question}

Answer drawing on both the document-level insights and the specific passages above. Be direct and specific — cite figures, names, and sources where available. If the knowledge base does not contain enough to answer confidently, say exactly what is and is not known.`,
      },
    ],
  })

  const answer = response.content[0].type === 'text' ? response.content[0].text : ''

  // Deduplicate sources by document title/ref
  const seenSources = new Set<string>()
  const sources = (chunks as Chunk[])
    .filter((c) => {
      const key = c.title ?? c.source_ref ?? ''
      if (seenSources.has(key)) return false
      seenSources.add(key)
      return true
    })
    .map((c) => ({
      title: c.title ?? c.source_ref ?? 'Untitled',
      source_type: c.source_type,
      source_ref: c.source_ref,
    }))

  return NextResponse.json({ answer, sources })
}
