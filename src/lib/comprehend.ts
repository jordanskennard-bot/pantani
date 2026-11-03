import Anthropic from '@anthropic-ai/sdk'
import { PASSO_CONTEXT } from './passo-context.ts'

// Initialised lazily so the env var is read at call time, not module load time
function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// The fixed tag vocabulary. Six tags follow the pillars of the Passo framework,
// five name channels, and the rest carry context. Definitions the model sees
// are in TAG_DEFINITIONS below; keep the two in step.
export const KNOWLEDGE_TAGS = [
  // Pillars of the Passo framework
  'strategy',            // messages, products, channel and budget allocation, seasonality, markets
  'kpis_metrics',        // unit economics, margin, CAC, LTV, payback, optimisation targets
  'data_tech',           // pixels, Conversions API, tags, consent, feeds, data flows
  'governance',          // account and campaign settings, structure, automation, budgets
  'creative',            // formats, variants, refresh, fatigue, messaging
  'validation',          // tests, geo holdouts, lift, attribution, reporting against own data
  // Channels
  'meta',
  'google',              // Search, Shopping, PMax, Demand Gen, YouTube ads, Merchant Center
  'pinterest',
  'tiktok',
  'other_channels',      // open-web display, CTV, audio, affiliates, retail media, new channels
  // Context
  'shopify',             // Shopify platform, apps, checkout, order data
  'subscription',        // subscription and repeat-purchase economics, retention
  'merchant_profile',    // how DTC brands behave, decide and spend
  'category_knowledge',  // vertical-specific knowledge
  'competitive_intel',   // agencies, tools and platforms competing with or adjacent to Passo
  'platform_changes',    // new features, betas, policy and algorithm changes
  'regulation',          // privacy, consent, brand safety, advertising standards
  'ai_in_marketing',     // AI tools and automation in media buying and agency work
] as const

const TAG_DEFINITIONS = `- strategy: which messages and products to push, channel and budget allocation, where and when to advertise, seasonality, market entry
- kpis_metrics: unit economics, contribution margin, CAC against LTV, payback, new-customer targets, the targets campaigns optimise to
- data_tech: pixels, Conversions API, server-side tagging, consent mode, product feeds, GA4, data flows into Shopify and the platforms
- governance: account and campaign settings, structure, consolidation, naming, bidding and automation settings, budgets and caps
- creative: ad formats, creative strategy, variants and diversity, refresh and fatigue, hooks, messaging, UGC and creators
- validation: incrementality and lift tests, geo holdouts, MMM, attribution models, reporting against Shopify or the brand's own data
- meta: Facebook and Instagram ads, Advantage+, Andromeda, Partnership Ads
- google: Google Search, Shopping, Performance Max, Demand Gen, YouTube ads, Merchant Center
- pinterest: Pinterest ads
- tiktok: TikTok ads and TikTok Shop
- other_channels: open-web display, CTV, audio, affiliates, retail media, email or SMS where paid media interacts, any other channel
- shopify: Shopify platform specifics, apps, checkout, order and customer data
- subscription: subscription and repeat-purchase businesses, retention, churn, payback on retained customers
- merchant_profile: how DTC and ecommerce brands behave, decide, staff and spend on paid media
- category_knowledge: knowledge specific to a vertical such as beauty, fashion, food, homeware, supplements
- competitive_intel: agencies, software and platforms that compete with or sit next to Passo, and how they sell
- platform_changes: new features, betas, pilots, policy or algorithm changes on any platform
- regulation: privacy law, consent, brand safety, advertising standards
- ai_in_marketing: AI tools, agents and automation used in media buying, creative or agency work`

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
        content: `You are classifying documents for Pantani, the knowledge bank behind Passo.

<passo>
${PASSO_CONTEXT}
</passo>

Classify this document. Pull out the facts and insights that would help Passo advise a Shopify brand on its paid media, under any of the six pillars and on any channel.

<document>
${truncated}
</document>

Tag definitions:
${TAG_DEFINITIONS}

Respond with JSON only, no explanation:
{
  "summary": "2-3 sentences: what the document says, and which pillars or channels it informs for Passo",
  "key_insights": [
    "Specific fact, statistic, claim, tactic or new feature, with numbers, names and dates where present",
    "..."
  ],
  "tags": ["tag1", "tag2"]
}

Rules:
- Write the summary and key insights in English, whatever language the document is in.
- Judge relevance on whether it helps advise a Shopify brand. Content about any channel, format or tool can be relevant.
- key_insights: 3-8 items. Each is a complete, standalone statement of what the source says. Report the source's facts and claims, attributed where useful ("the speaker reports..."). Do not explain what the insight means for Passo.
- Prioritise specific data points, settings, test results, new features and betas over general observations. If the document has no specific facts, give its 3-5 most actionable points.
- tags: tag only what the document is mainly about, so a tag is useful for filtering. At most two pillar tags (strategy, kpis_metrics, data_tech, governance, creative, validation), at most two channel tags, and at most two context tags. A passing mention does not earn a tag. If no pillar is a main subject, use none. Most documents need 2-4 tags in total.
- If the transcript or text is missing or empty, say so in the summary, return no key insights and no tags.`,
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
