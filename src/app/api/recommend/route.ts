// POST /api/recommend
//
// Takes a batch of health check findings and returns one recommendation per
// finding. The work is in src/lib/recommend.ts; this file is the wiring: auth,
// parse, the three live calls, and the status codes.
//
// Auth is its own, as /api/ingest/email's is, because the caller is a service
// rather than a signed-in operator. The path is listed in src/middleware.ts.
//
// Nothing here is stored, and nothing logged carries a word of the request.

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { embedQueries } from '@/lib/embeddings'
import { getSupabase } from '@/lib/supabase'
import {
  MATCH_COUNT,
  RECOMMEND_TOOL,
  RecommendError,
  RecommendRequestSchema,
  buildRecommendations,
  checkServiceKey,
  type ModelRecommendation,
  type SearchRow,
} from '@/lib/recommend'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'claude-sonnet-4-5'

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

/** One search_knowledge call. No source or tag filter: any document may bear on a finding. */
async function searchKnowledge(embedding: number[]): Promise<SearchRow[]> {
  const { data, error } = await getSupabase().rpc('search_knowledge', {
    query_embedding: JSON.stringify(embedding),
    match_count: MATCH_COUNT,
    filter_source_type: null,
    filter_tags: null,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as SearchRow[]
}

/** One Claude call for the whole batch, through the tool so the reply is structured. */
async function generate(args: {
  system: string
  user: string
  tool: typeof RECOMMEND_TOOL
}): Promise<ModelRecommendation[]> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: args.system,
    tools: [args.tool],
    tool_choice: { type: 'tool', name: args.tool.name },
    messages: [{ role: 'user', content: args.user }],
  })

  const call = response.content.find((block) => block.type === 'tool_use')
  if (!call || call.type !== 'tool_use') throw new Error('The model did not call the tool.')
  const written = (call.input as { recommendations?: unknown }).recommendations
  if (!Array.isArray(written)) throw new Error('The model returned no recommendations.')

  // Shape only. Whether a recommendation may be published is decided in
  // src/lib/recommend.ts, which drops anything that fails its checks.
  return written.filter(
    (entry): entry is ModelRecommendation =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as ModelRecommendation).code === 'string' &&
      typeof (entry as ModelRecommendation).recommendation === 'string',
  ).map((entry) => ({
    code: entry.code,
    recommendation: entry.recommendation,
    source_indexes: Array.isArray(entry.source_indexes)
      ? entry.source_indexes.filter((n): n is number => Number.isInteger(n))
      : [],
  }))
}

export async function POST(request: NextRequest) {
  const auth = checkServiceKey(request.headers.get('authorization'), process.env.PANTANI_SERVICE_KEY)
  if (!auth.ok) {
    return auth.status === 503
      ? NextResponse.json({ error: 'Recommendations are not configured.' }, { status: 503 })
      : NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = RecommendRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const recommendations = await buildRecommendations(parsed.data, {
      embedQueries,
      searchKnowledge,
      generate,
      log: (line) => console.log(line),
    })
    return NextResponse.json({ recommendations })
  } catch (error) {
    if (error instanceof RecommendError) {
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    return NextResponse.json({ error: 'Could not write the recommendations.' }, { status: 502 })
  }
}
