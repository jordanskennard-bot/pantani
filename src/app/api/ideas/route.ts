// POST /api/ideas
//
// Takes the sections of a health check that ran and returns up to three ideas
// worth testing for each: new features, betas and tactics the account is not
// using yet. The work is in src/lib/ideas.ts; this file is the wiring: auth,
// parse, the three live calls, and the status codes.
//
// Auth is its own, as /api/recommend's is, because the caller is a service
// rather than a signed-in operator. Both read the same check from
// src/lib/service-auth.ts. The path is listed in src/middleware.ts.
//
// Nothing here is stored, and nothing logged carries a word of the request.

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { embedQueries } from '@/lib/embeddings'
import { getSupabase } from '@/lib/supabase'
import { checkServiceKey } from '@/lib/service-auth'
import {
  IDEAS_TOOL,
  IdeasError,
  IdeasRequestSchema,
  MATCH_COUNT,
  buildIdeas,
  type ModelSection,
  type SearchRow,
} from '@/lib/ideas'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'claude-sonnet-4-5'

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

/**
 * One search_knowledge call, inside the recency window.
 *
 * No source or tag filter: a new feature may be written up anywhere. The
 * window is applied in the query rather than here, so the whole match_count
 * budget is spent on documents inside it (migration 007).
 */
async function searchKnowledge(embedding: number[], after: Date): Promise<SearchRow[]> {
  const { data, error } = await getSupabase().rpc('search_knowledge', {
    query_embedding: JSON.stringify(embedding),
    match_count: MATCH_COUNT,
    filter_source_type: null,
    filter_tags: null,
    filter_after: after.toISOString(),
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as SearchRow[]
}

/** One Claude call for the whole batch, through the tool so the reply is structured. */
async function generate(args: {
  system: string
  user: string
  tool: typeof IDEAS_TOOL
}): Promise<ModelSection[]> {
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
  const written = (call.input as { sections?: unknown }).sections
  if (!Array.isArray(written)) throw new Error('The model returned no sections.')

  // Shape only. Whether an idea may be published is decided in
  // src/lib/ideas.ts, which drops anything that fails its checks.
  return written
    .filter(
      (entry): entry is { code: string; ideas?: unknown } =>
        !!entry && typeof entry === 'object' && typeof (entry as { code?: unknown }).code === 'string',
    )
    .map((entry) => ({
      code: entry.code,
      ideas: Array.isArray(entry.ideas)
        ? entry.ideas
            .filter(
              (idea): idea is Record<string, unknown> =>
                !!idea &&
                typeof idea === 'object' &&
                typeof (idea as { title?: unknown }).title === 'string' &&
                typeof (idea as { what?: unknown }).what === 'string' &&
                typeof (idea as { how?: unknown }).how === 'string',
            )
            .map((idea) => ({
              title: idea.title as string,
              what: idea.what as string,
              how: idea.how as string,
              source_indexes: Array.isArray(idea.source_indexes)
                ? (idea.source_indexes as unknown[]).filter((n): n is number => Number.isInteger(n))
                : [],
            }))
        : [],
    }))
}

export async function POST(request: NextRequest) {
  const auth = checkServiceKey(request.headers.get('authorization'), process.env.PANTANI_SERVICE_KEY)
  if (!auth.ok) {
    return auth.status === 503
      ? NextResponse.json({ error: 'Ideas are not configured.' }, { status: 503 })
      : NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = IdeasRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const sections = await buildIdeas(parsed.data, {
      embedQueries,
      searchKnowledge,
      generate,
      log: (line) => console.log(line),
    })
    return NextResponse.json({ sections })
  } catch (error) {
    if (error instanceof IdeasError) {
      return NextResponse.json({ error: error.message }, { status: 502 })
    }
    return NextResponse.json({ error: 'Could not write the ideas.' }, { status: 502 })
  }
}
