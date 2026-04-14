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

  // 1. Vector search — semantic similarity
  const { data: vectorChunks, error } = await getSupabase().rpc('search_knowledge', {
    query_embedding: JSON.stringify(embedding),
    match_count: 15,
    filter_source_type: null,
    filter_tags: null,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // 2. Keyword search — find documents whose title or summary contains words from the question
  // This catches named entities (companies, platforms, products) that vector search can miss
  const keywords = question
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(w => w.length > 3)

  let keywordChunks: Chunk[] = []
  if (keywords.length > 0) {
    const vectorDocIds = new Set((vectorChunks ?? []).map((c: Chunk) => c.document_id))

    // Search for documents matching any keyword in title or summary
    const keywordMatches = await Promise.all(
      keywords.map(kw =>
        getSupabase()
          .from('documents')
          .select('id, source_type, source_ref, title, summary, key_insights, tags')
          .or(`title.ilike.%${kw}%,summary.ilike.%${kw}%`)
          .limit(3)
      )
    )

    const matchedDocIds = [
      ...new Set(
        keywordMatches
          .flatMap(r => r.data ?? [])
          .filter(d => !vectorDocIds.has(d.id))
          .map(d => d.id)
      ),
    ]

    if (matchedDocIds.length > 0) {
      // Fetch top 3 chunks per matched document
      const { data: extra } = await getSupabase()
        .from('chunks')
        .select(`
          id,
          document_id,
          content,
          context_prefix,
          chunk_index,
          documents!inner(source_type, source_ref, title, summary, key_insights, tags)
        `)
        .in('document_id', matchedDocIds)
        .order('chunk_index')
        .limit(matchedDocIds.length * 3)

      if (extra) {
        keywordChunks = extra.map((c: any) => ({
          chunk_id: c.id,
          document_id: c.document_id,
          source_type: c.documents.source_type,
          source_ref: c.documents.source_ref,
          title: c.documents.title,
          summary: c.documents.summary,
          key_insights: c.documents.key_insights ?? [],
          tags: c.documents.tags ?? [],
          content: c.content,
          context_prefix: c.context_prefix,
          similarity: 0,
        }))
      }
    }
  }

  // Merge — vector results first, keyword results appended
  const chunks: Chunk[] = [...(vectorChunks ?? []), ...keywordChunks]

  if (chunks.length === 0) {
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
        content: `You are Pantani — the knowledge layer of Passo, an autonomous programmatic media agency for Shopify DTC merchants in the UK. Passo's agents (Galibier for strategy, Gavia for attribution, Izoard for audience, Stelvio for execution) rely on your answers to make media decisions.

Your job is to give the most complete, useful answer possible. Use the following approach:

1. PRIORITISE the knowledge base below — it contains Passo-specific research, benchmarks, and curated intelligence. Cite it directly where it is relevant.
2. SUPPLEMENT with your own knowledge where the knowledge base is thin or silent. Programmatic advertising, DTC media buying, Shopify, attribution, CPM benchmarks, audience strategy — use everything you know.
3. BE CLEAR about the source: distinguish between what comes from Passo's knowledge base ("according to [source]...") and what is general knowledge ("generally speaking..." or "based on industry norms...").
4. NEVER refuse to answer because the knowledge base alone is insufficient. Incomplete knowledge base coverage is not a reason to withhold a useful answer.

PASSO KNOWLEDGE BASE — DOCUMENT SUMMARIES AND KEY INSIGHTS:
${docContext}

PASSO KNOWLEDGE BASE — RELEVANT PASSAGES:
${chunkContext}

---

Question: ${question}

Give a complete, direct answer. Lead with what the knowledge base says, then fill any gaps with your broader knowledge. Be specific — include figures, platform names, and concrete recommendations where relevant.`,
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
