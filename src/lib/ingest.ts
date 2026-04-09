import { createHash } from 'crypto'
import { supabase } from './supabase'
import { embedTexts } from './embeddings'
import { chunkText } from './chunk'
import { classifyDocument, generateChunkContexts } from './comprehend'

type IngestInput = {
  sourceType: 'email' | 'file' | 'url' | 'youtube'
  sourceRef?: string
  sourceFrom?: string
  title?: string
  text: string
  metadata?: Record<string, unknown>
}

type IngestResult = {
  documentId: string
  chunkCount: number
  tags: string[]
  summary: string
  duplicate?: boolean
}

// Ingest a piece of text into the libro di corsa:
// 1. Classify the document (Claude) — summary + tags
// 2. Store the document record
// 3. Chunk the text
// 4. Generate context prefixes for each chunk (Claude)
// 5. Embed context+chunk for each chunk (Voyage AI)
// 6. Store chunks + embeddings
export async function ingest(input: IngestInput): Promise<IngestResult> {
  const { sourceType, sourceRef, sourceFrom, title, text, metadata = {} } = input

  // 0. Duplicate check — hash the text and bail early if we've seen it before
  const contentHash = createHash('md5').update(text).digest('hex')
  const { data: existing } = await supabase
    .from('documents')
    .select('id, tags, summary')
    .eq('content_hash', contentHash)
    .maybeSingle()

  if (existing) {
    return {
      documentId: existing.id,
      chunkCount: 0,
      tags: existing.tags ?? [],
      summary: existing.summary ?? '',
      duplicate: true,
    }
  }

  // 1. Classify — runs in parallel with nothing else yet, cheap Haiku call
  const comprehension = await classifyDocument(text)

  // 2. Insert the document record with comprehension data
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .insert({
      source_type: sourceType,
      source_ref: sourceRef ?? null,
      source_from: sourceFrom ?? null,
      title: title ?? sourceRef ?? null,
      raw_text: text,
      token_count: Math.round(text.length / 4),
      metadata,
      summary: comprehension.summary,
      tags: comprehension.tags,
      content_hash: contentHash,
    })
    .select('id')
    .single()

  if (docError || !doc) {
    throw new Error(`Failed to insert document: ${docError?.message}`)
  }

  // 3. Chunk the text
  const chunks = chunkText(text)
  if (chunks.length === 0) {
    return { documentId: doc.id, chunkCount: 0, tags: comprehension.tags, summary: comprehension.summary }
  }

  // 4. Generate context prefixes for all chunks — one Claude call for the whole document
  const contextPrefixes = await generateChunkContexts(text, chunks)

  // 5. Embed context+chunk — the embedding carries both the local content and its
  //    position/meaning within the document, improving retrieval accuracy
  const contextualisedChunks = chunks.map((chunk, i) =>
    contextPrefixes[i] ? `${contextPrefixes[i]} ${chunk}` : chunk
  )

  const BATCH_SIZE = 64
  const BATCH_DELAY_MS = 20_000
  const allEmbeddings: number[][] = []
  for (let i = 0; i < contextualisedChunks.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    const batch = contextualisedChunks.slice(i, i + BATCH_SIZE)
    const embeddings = await embedTexts(batch)
    allEmbeddings.push(...embeddings)
  }

  // 6. Insert chunks — store raw content separately from context prefix so agents
  //    receive clean text, but the embedding was built with full context
  const chunkRows = chunks.map((content, i) => ({
    document_id: doc.id,
    chunk_index: i,
    content,
    context_prefix: contextPrefixes[i] ?? null,
    embedding: JSON.stringify(allEmbeddings[i]),
  }))

  const { error: chunkError } = await supabase.from('chunks').insert(chunkRows)

  if (chunkError) {
    console.error(`Failed to insert chunks for document ${doc.id}:`, chunkError.message)
  }

  return {
    documentId: doc.id,
    chunkCount: chunks.length,
    tags: comprehension.tags,
    summary: comprehension.summary,
  }
}
