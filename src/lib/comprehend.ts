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
  'adcp',                // Ads Context Protocol — agentic ad buying standards and specs
  'artf',                // Agentic Real Time Framework — real-time agentic media execution
  'agentic',             // AI agents in media buying, autonomous campaign management
  'new_customer',        // new customer acquisition, prospecting, new-to-brand measurement, incremental reach
  'incrementality',      // lift studies, causal measurement, verified vs platform-reported ROAS, Shopify reconciliation
  'shopify',             // Shopify platform specifics, revenue data, order reconciliation, merchant store structure
] as const

export type KnowledgeTag = typeof KNOWLEDGE_TAGS[number]

export type DocumentComprehension = {
  summary: string
  key_insights: string[]
  tags: KnowledgeTag[]
}

export type ChunkContext = {
  chunkIndex: number
  contextPrefix: string
}

// Step 1 — Classify the document: summary + key_insights + tags
// One Claude call per document, regardless of length.
export async function classifyDocument(text: string): Promise<DocumentComprehension> {
  const truncated = text.slice(0, 12_000) // stay well within context for classification

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content: `You are classifying documents for Pantani — the knowledge and orchestration layer of Passo, an autonomous programmatic media agency for Shopify DTC merchants in the UK.

Passo's model: it connects to a merchant's Shopify store, builds a media strategy, and autonomously executes programmatic media (display, native, audio, CTV) across premium publisher inventory — channels small merchants cannot normally access. It focuses exclusively on new customer acquisition, never retargeting. Shopify order data is the single source of truth for measuring success, not platform-reported ROAS figures.

The technology: Passo uses PubMatic's AgenticOS (an implementation of the Agentic Real Time Framework, ARTF) to buy inventory autonomously without a trading desk. It buys through AdCP (Ads Context Protocol) — direct from premium publishers rather than open RTB exchanges. The intelligence layer runs on the Claude API.

Classify this document. Extract the key facts and insights that Passo's agents (Galibier for strategy, Gavia for attribution, Izoard for audience, Stelvio for execution) would find decision-relevant.

<document>
${truncated}
</document>

Tag definitions:
- competitive_intel: research on Triple Whale, Criteo GO, AdRoll, Meta, Google, or other platforms competing with or adjacent to Passo
- programmatic: how programmatic buying works — DSPs, SSPs, RTB mechanics, inventory types, ad formats, supply path
- cpm_benchmarks: CPM pricing data, floor prices, rate cards, cost benchmarks by format, channel, or vertical
- attribution: ROAS measurement methodologies, last-click vs view-through, MTA, MMM, platform attribution models
- audience: targeting approaches, audience signals, lookalikes, intent scoring, contextual targeting
- merchant_profile: DTC merchant behaviour, psychology, decision-making, paid media maturity, spend patterns
- category_knowledge: vertical-specific knowledge — homeware, fashion, skincare, consumer goods, specific product categories
- platform_intel: PubMatic, AgenticOS, Meta Ads, Google Ads, specific platform mechanics, publisher environments
- regulation: GDPR, brand safety, IAB standards, consent frameworks, ISBA/ANA governance
- adcp: Ads Context Protocol — the standard for agentic, direct programmatic buying from premium publishers outside open RTB
- artf: Agentic Real Time Framework — the technical framework enabling autonomous real-time programmatic execution by AI agents
- agentic: AI agents in media buying, autonomous campaign management, agent architecture, agent registries (IAB Tech Lab)
- new_customer: new customer acquisition strategies, prospecting, new-to-brand targeting, incremental reach, upper-funnel buying
- incrementality: lift studies, incrementality testing, causal attribution, verifying whether media spend actually drove sales vs organic
- shopify: Shopify platform specifics, revenue reconciliation against order data, Shopify API, merchant store data structures

Respond with JSON only, no explanation:
{
  "summary": "2-3 sentences covering what this document is about and why it is relevant to Passo",
  "key_insights": [
    "Specific fact, statistic, claim, or decision-relevant finding — include numbers, names, dates where present",
    "..."
  ],
  "tags": ["tag1", "tag2"]
}

key_insights rules: 3-8 items. Each must be a complete, standalone statement. Prioritise specific data points (CPM figures, percentages, platform names, dates) over general observations. If the document contains no specific facts, summarise the 3-5 most actionable points.`,
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
      key_insights: Array.isArray(parsed.key_insights) ? parsed.key_insights.filter(Boolean) : [],
      tags,
    }
  } catch {
    return { summary: '', key_insights: [], tags: [] }
  }
}

// Step 2 — Generate insight-focused context prefixes for all chunks.
// Each prefix names the key fact or claim in the chunk, not just its location.
// Batches into groups of 50 to stay within safe token limits.
// Returns one context sentence per chunk, in order.
export async function generateChunkContexts(
  documentText: string,
  chunks: string[],
): Promise<string[]> {
  if (chunks.length === 0) return []

  const truncatedDoc = documentText.slice(0, 10_000)
  const BATCH_SIZE = 50
  const allContexts: string[] = []

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const chunkList = batch
      .map((c, j) => `Chunk ${i + j + 1}:\n${c.slice(0, 400)}`)
      .join('\n\n')

    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Here is a document:
<document>
${truncatedDoc}
</document>

For each chunk below, write one sentence (max 150 characters) identifying the most important fact, claim, statistic, or data point in that chunk. Include specific numbers, names, platform names, or dates if present. If the chunk contains no specific notable claim, describe its primary subject concisely.

${chunkList}

Respond with a JSON array of strings, one per chunk, in order:
["key insight for chunk 1", "key insight for chunk 2", ...]`,
        },
      ],
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text : '[]'

    try {
      const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
      batch.forEach((_, j) => allContexts.push(parsed[j] ?? ''))
    } catch {
      batch.forEach(() => allContexts.push(''))
    }
  }

  return allContexts
}
