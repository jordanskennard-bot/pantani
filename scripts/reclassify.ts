// Rewrites each stored document's summary, key insights and tags against the
// current Passo context (src/lib/passo-context.ts). Chunks and embeddings are
// untouched: chunk prefixes do not mention Passo, so nothing needs re-embedding.
//
// Run from the repo root, with the production keys in .env.local:
//   node --env-file=.env.local --experimental-strip-types --no-warnings scripts/reclassify.ts --dry-run
//   node --env-file=.env.local --experimental-strip-types --no-warnings scripts/reclassify.ts
//
// --dry-run   classify the first 3 documents and print the result, write nothing
// --limit N   stop after N documents
// --force     reclassify documents already on the current context version
//
// Safe to stop and rerun: each document records the context version it was
// classified with (metadata.passo_context), and finished ones are skipped.
// One Haiku call per document, four at a time.

import { createClient } from '@supabase/supabase-js'
import { classifyDocument } from '../src/lib/comprehend.ts'
import { PASSO_CONTEXT_VERSION } from '../src/lib/passo-context.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const limitArg = args.indexOf('--limit')
const limit = dryRun ? 3 : limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity
const CONCURRENCY = 4
const PAGE = 500

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key || !process.env.ANTHROPIC_API_KEY) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY must be set')
  process.exit(1)
}
const db = createClient(url, key)

type Row = { id: string; title: string | null; metadata: Record<string, unknown> | null }

async function pendingDocuments(): Promise<Row[]> {
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('documents')
      .select('id, title, metadata')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Listing documents failed: ${error.message}`)
    rows.push(...(data as Row[]))
    if (!data || data.length < PAGE) break
  }
  return rows.filter((r) => force || r.metadata?.passo_context !== PASSO_CONTEXT_VERSION)
}

async function reclassify(row: Row): Promise<'done' | 'empty' | 'failed'> {
  const { data, error } = await db.from('documents').select('raw_text').eq('id', row.id).single()
  if (error || !data) return 'failed'
  const text: string = data.raw_text ?? ''
  if (text.trim().length === 0) return 'empty'

  const result = await classifyDocument(text)
  if (!result.summary) return 'failed' // unparseable answer: leave the old values in place

  if (dryRun) {
    console.log(`\n── ${row.title ?? row.id}`)
    console.log(JSON.stringify(result, null, 2))
    return 'done'
  }

  const { error: updateError } = await db
    .from('documents')
    .update({
      summary: result.summary,
      key_insights: result.key_insights,
      tags: result.tags,
      metadata: { ...(row.metadata ?? {}), passo_context: PASSO_CONTEXT_VERSION },
    })
    .eq('id', row.id)
  return updateError ? 'failed' : 'done'
}

async function main() {
  const pending = (await pendingDocuments()).slice(0, limit)
  console.log(`${pending.length} documents to reclassify against context ${PASSO_CONTEXT_VERSION}${dryRun ? ' (dry run)' : ''}`)

  const counts = { done: 0, empty: 0, failed: 0 }
  const failed: string[] = []
  let next = 0
  async function worker() {
    while (next < pending.length) {
      const row = pending[next++]
      let outcome: keyof typeof counts
      try {
        outcome = await reclassify(row)
      } catch (e) {
        console.error(`${row.id}: ${(e as Error).message}`)
        outcome = 'failed'
      }
      counts[outcome]++
      if (outcome === 'failed') failed.push(row.id)
      const n = counts.done + counts.empty + counts.failed
      if (!dryRun && n % 25 === 0) console.log(`${n}/${pending.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\nDone: ${counts.done}. Empty text, skipped: ${counts.empty}. Failed: ${counts.failed}.`)
  if (failed.length) console.log(`Failed ids (rerun to retry): ${failed.join(', ')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
