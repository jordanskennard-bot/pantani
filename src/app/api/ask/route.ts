import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { embedQuery } from '@/lib/embeddings'
import { getSupabase } from '@/lib/supabase'

export const runtime = 'nodejs'

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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
  } catch (err) {
    return NextResponse.json({ error: 'Failed to embed question' }, { status: 500 })
  }

  // Retrieve top chunks
  const { data: chunks, error } = await getSupabase().rpc('search_knowledge', {
    query_embedding: JSON.stringify(embedding),
    match_count: 8,
    filter_source_type: null,
    filter_tags: null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!chunks || chunks.length === 0) {
    return NextResponse.json({ answer: 'No relevant knowledge found. Try ingesting some documents first.', sources: [] })
  }

  // Build context for Claude
  const context = chunks
    .map((c: { title: string; source_type: string; source_ref: string; context_prefix: string; content: string }, i: number) =>
      `[${i + 1}] ${c.title ?? c.source_ref ?? 'Untitled'} (${c.source_type})\n${c.context_prefix ? c.context_prefix + '\n' : ''}${c.content}`
    )
    .join('\n\n---\n\n')

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are Pantani — the knowledge layer of Passo, an autonomous programmatic media agency for Shopify DTC merchants. You answer questions concisely and precisely based only on the knowledge in your store.

Relevant knowledge:

${context}

---

Question: ${question}

Answer based only on the sources above. Be direct and specific. If the sources do not contain enough to answer, say so clearly. Do not speculate beyond what the sources say.`,
      },
    ],
  })

  const answer = response.content[0].type === 'text' ? response.content[0].text : ''

  // Deduplicate sources by document title/ref
  const seen = new Set<string>()
  const sources = chunks
    .filter((c: { title: string; source_ref: string; source_type: string }) => {
      const key = c.title ?? c.source_ref ?? ''
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((c: { title: string; source_ref: string; source_type: string }) => ({
      title: c.title ?? c.source_ref ?? 'Untitled',
      source_type: c.source_type,
      source_ref: c.source_ref,
    }))

  return NextResponse.json({ answer, sources })
}
