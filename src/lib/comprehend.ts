import Anthropic from '@anthropic-ai/sdk'

// Initialised lazily so the env var is read at call time, not module load time
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// The fixed tag vocabulary — maps to Pantani's agent knowledge domains
export const KNOWLEDGE_TAGS = [
  'competitive_intel',   // Triple Whale, Criteo, AdRoll, other platforms
  'programmatic',        // how buying works, DSPs, SSPs, inventory mechanics
  'cpm_benchmarks',      // pricing data, CPM ranges by format/channel
  'attribution',         // ROAS measurement, Shopify reconciliation, view-through
  'audience',            // targeting, signals, lookalikes, intent scoring
  'merchant_profile',    // DTC merchant behaviour, psychology, decision-making
  'category_knowledge',  // homeware, fashion, skincare, specific verticals
  'platform_intel',      // PubMatic, Meta, Google specifics, AgenticOS
  'regulation',          // GDPR, brand safety, IAB standards, consent
] as const

export type KnowledgeTag = typeof KNOWLEDGE_TAGS[number]

export type DocumentComprehension = {
  summary: string
  tags: KnowledgeTag[]
}

export type ChunkContext = {
  chunkIndex: number
  contextPrefix: string
}

// Step 1 — Classify the document: summary + tags
// One Claude call per document, regardless of length.
export async function classifyDocument(text: string): Promise<DocumentComprehension> {
  const truncated = text.slice(0, 12_000) // stay well within context for classification

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are classifying documents for Pantani — the knowledge and orchestration layer of Passo, an autonomous media agency for Shopify DTC merchants in the UK.

Passo buys programmatic media (display, native, audio, CTV) for small merchants who currently only use Meta and Google. Pantani needs to understand competitive intelligence, programmatic methodology, CPM benchmarks, attribution approaches, audience signals, merchant behaviour, vertical-specific knowledge, and platform mechanics.

Classify this document:

<document>
${truncated}
</document>

Respond with JSON only, no explanation:
{
  "summary": "2-3 sentences covering what this document is about and why it is relevant to Passo",
  "tags": ["tag1", "tag2"]
}

Available tags (choose all that apply):
${KNOWLEDGE_TAGS.join(', ')}`,
      },
    ],
  })

  const raw = response.content[0].type === 'text' ? response.content[0].text : ''

  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
    const tags = (parsed.tags ?? []).filter((t: string) =>
      KNOWLEDGE_TAGS.includes(t as KnowledgeTag)
    ) as KnowledgeTag[]
    return {
      summary: parsed.summary ?? '',
      tags,
    }
  } catch {
    return { summary: '', tags: [] }
  }
}

// Step 2 — Generate context prefixes for all chunks in one call.
// Sends the full document once, asks Claude to situate each chunk within it.
// Returns one context sentence per chunk, in order.
export async function generateChunkContexts(
  documentText: string,
  chunks: string[],
): Promise<string[]> {
  if (chunks.length === 0) return []

  const truncatedDoc = documentText.slice(0, 10_000)
  const chunkList = chunks
    .map((c, i) => `Chunk ${i + 1}:\n${c.slice(0, 400)}`)
    .join('\n\n')

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: chunks.length * 60, // ~60 tokens per context sentence
    messages: [
      {
        role: 'user',
        content: `Here is a document:
<document>
${truncatedDoc}
</document>

For each chunk below, write one sentence (max 120 characters) that situates the chunk within the document — what subject it covers and where it fits. Be specific. Do not summarise, just contextualise.

${chunkList}

Respond with a JSON array of strings, one per chunk, in order:
["context for chunk 1", "context for chunk 2", ...]`,
      },
    ],
  })

  const raw = response.content[0].type === 'text' ? response.content[0].text : '[]'

  try {
    const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
    // Pad or trim to match chunk count
    const result: string[] = chunks.map((_, i) => parsed[i] ?? '')
    return result
  } catch {
    return chunks.map(() => '')
  }
}
