// Unit tests for the recommend route's work. The Voyage, Supabase and
// Anthropic calls are injected, so nothing here reaches the network.
//
// Run with: npm test

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MIN_SIMILARITY,
  RecommendError,
  RecommendRequestSchema,
  buildRecommendations,
  buildUserTurn,
  checkServiceKey,
  indexPassages,
  queryFor,
  sanitiseRecommendation,
  selectPassages,
  sourcesFor,
  type Passage,
  type RecommendDeps,
  type RecommendRequest,
  type SearchRow,
} from './recommend.ts'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const B2 = {
  code: 'B2',
  severity: 'urgent' as const,
  title: 'Broad match is uncapped and converting queries are uncovered',
  detail:
    '62% of keyword spend ($41,200) is on broad match without a cost or return target. We recommend keeping that under 25%. 8 of the top 20 converting queries have phrase or exact cover.',
  action: 'Add phrase or exact keywords for converting queries, and cap broad match with a target or prune it.',
  examples: ['barndominium plans', 'modern farmhouse plans'],
}

const request: RecommendRequest = {
  channel: 'google_ads',
  client: { name: 'Architectural Designs', markets: ['US', 'CA'] },
  findings: [B2],
}

function row(over: Partial<SearchRow> = {}): SearchRow {
  return {
    chunk_id: 'chunk-1',
    document_id: 'doc-1',
    source_type: 'youtube',
    source_ref: 'https://example.com/one',
    title: 'Match types and budget control',
    key_insights: ['Broad match needs a target to bid sanely.'],
    content: 'Move converting queries to exact match first.',
    similarity: 0.8,
    ...over,
  }
}

function passage(over: Partial<Passage> = {}): Passage {
  return {
    chunk_id: 'chunk-1',
    title: 'Match types and budget control',
    source_ref: 'https://example.com/one',
    source_type: 'youtube',
    key_insights: [],
    content: 'Move converting queries to exact match first.',
    ...over,
  }
}

/** Deps that succeed, with the model's reply and the search rows swappable. */
function deps(over: Partial<RecommendDeps> = {}): RecommendDeps {
  return {
    embedQueries: async (texts) => texts.map(() => [0.1, 0.2]),
    searchKnowledge: async () => [row()],
    generate: async () => [
      { code: 'B2', recommendation: 'We recommend moving the converting queries into exact match first.', source_indexes: [1] },
    ],
    ...over,
  }
}

// ─── The auth check ─────────────────────────────────────────────────────────

describe('checkServiceKey', () => {
  it('accepts the right key as a bearer token', () => {
    assert.deepEqual(checkServiceKey('Bearer s3cret-key', 's3cret-key'), { ok: true })
  })

  it('refuses a wrong key of the same length with 401', () => {
    assert.deepEqual(checkServiceKey('Bearer s3cret-kez', 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses a wrong key of a different length with 401', () => {
    assert.deepEqual(checkServiceKey('Bearer short', 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses a missing header with 401', () => {
    assert.deepEqual(checkServiceKey(null, 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses a header that is not a bearer token with 401', () => {
    assert.deepEqual(checkServiceKey('s3cret-key', 's3cret-key'), { ok: false, status: 401 })
  })

  it('refuses an empty bearer token with 401', () => {
    assert.deepEqual(checkServiceKey('Bearer ', 's3cret-key'), { ok: false, status: 401 })
  })

  it('answers 503 when the key is unset on the server, whatever was sent', () => {
    assert.deepEqual(checkServiceKey('Bearer anything', undefined), { ok: false, status: 503 })
    assert.deepEqual(checkServiceKey('Bearer anything', ''), { ok: false, status: 503 })
  })
})

// ─── Input validation ───────────────────────────────────────────────────────

describe('RecommendRequestSchema', () => {
  it('accepts the B2 example', () => {
    const parsed = RecommendRequestSchema.safeParse(request)
    assert.equal(parsed.success, true)
  })

  it('accepts a finding with no action and no examples', () => {
    const parsed = RecommendRequestSchema.safeParse({
      ...request,
      findings: [{ code: 'C1', severity: 'opportunity', title: 'A title', detail: 'Some detail' }],
    })
    assert.equal(parsed.success, true)
  })

  it('refuses an empty findings array', () => {
    assert.equal(RecommendRequestSchema.safeParse({ ...request, findings: [] }).success, false)
  })

  it('refuses more than 40 findings', () => {
    const findings = Array.from({ length: 41 }, (_, i) => ({ ...B2, code: `B${i}` }))
    assert.equal(RecommendRequestSchema.safeParse({ ...request, findings }).success, false)
  })

  it('accepts exactly 40 findings', () => {
    const findings = Array.from({ length: 40 }, (_, i) => ({ ...B2, code: `B${i}` }))
    assert.equal(RecommendRequestSchema.safeParse({ ...request, findings }).success, true)
  })

  it('refuses a severity the page does not send', () => {
    const parsed = RecommendRequestSchema.safeParse({ ...request, findings: [{ ...B2, severity: 'ok' }] })
    assert.equal(parsed.success, false)
  })

  it('refuses a title over 300 characters', () => {
    const parsed = RecommendRequestSchema.safeParse({ ...request, findings: [{ ...B2, title: 'x'.repeat(301) }] })
    assert.equal(parsed.success, false)
  })

  it('refuses a detail over 2000 characters', () => {
    const parsed = RecommendRequestSchema.safeParse({ ...request, findings: [{ ...B2, detail: 'x'.repeat(2001) }] })
    assert.equal(parsed.success, false)
  })

  it('refuses an action over 500 characters', () => {
    const parsed = RecommendRequestSchema.safeParse({ ...request, findings: [{ ...B2, action: 'x'.repeat(501) }] })
    assert.equal(parsed.success, false)
  })

  it('refuses an example over 200 characters, and more than 20 examples', () => {
    assert.equal(
      RecommendRequestSchema.safeParse({ ...request, findings: [{ ...B2, examples: ['x'.repeat(201)] }] }).success,
      false,
    )
    assert.equal(
      RecommendRequestSchema.safeParse({
        ...request,
        findings: [{ ...B2, examples: Array.from({ length: 21 }, () => 'a') }],
      }).success,
      false,
    )
  })

  it('refuses a request with no client name', () => {
    assert.equal(RecommendRequestSchema.safeParse({ ...request, client: { name: '' } }).success, false)
  })

  it('reports issues a caller can act on', () => {
    const parsed = RecommendRequestSchema.safeParse({ channel: 'google_ads' })
    assert.equal(parsed.success, false)
    if (!parsed.success) assert.ok(parsed.error.issues.length > 0)
  })
})

// ─── The similarity cut-off ─────────────────────────────────────────────────

describe('selectPassages', () => {
  it('keeps a passage on the floor and drops one below it', () => {
    const kept = selectPassages([
      row({ chunk_id: 'a', similarity: MIN_SIMILARITY }),
      row({ chunk_id: 'b', similarity: MIN_SIMILARITY - 0.01 }),
    ])
    assert.deepEqual(
      kept.map((p) => p.chunk_id),
      ['a'],
    )
  })

  it('returns nothing when every row is below the floor', () => {
    assert.deepEqual(selectPassages([row({ similarity: 0.2 }), row({ chunk_id: 'b', similarity: 0.34 })]), [])
  })

  it('dedupes by chunk id', () => {
    const kept = selectPassages([row({ chunk_id: 'a' }), row({ chunk_id: 'a' }), row({ chunk_id: 'b' })])
    assert.deepEqual(
      kept.map((p) => p.chunk_id),
      ['a', 'b'],
    )
  })

  it('keeps at most six, highest similarity first', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ chunk_id: `c${i}`, similarity: 0.4 + i / 100 }))
    const kept = selectPassages(rows)
    assert.equal(kept.length, 6)
    assert.deepEqual(
      kept.map((p) => p.chunk_id),
      ['c8', 'c7', 'c6', 'c5', 'c4', 'c3'],
    )
  })

  it('falls back to the reference, then to Untitled, for a document with no title', () => {
    assert.equal(selectPassages([row({ title: null })])[0].title, 'https://example.com/one')
    assert.equal(selectPassages([row({ title: null, source_ref: null })])[0].title, 'Untitled')
  })

  it('reads a null key_insights as none', () => {
    assert.deepEqual(selectPassages([row({ key_insights: null })])[0].key_insights, [])
  })
})

// ─── Source mapping ─────────────────────────────────────────────────────────

describe('indexPassages and sourcesFor', () => {
  it('numbers passages across the batch from one', () => {
    const indexed = indexPassages([[passage({ chunk_id: 'a' })], [passage({ chunk_id: 'b' }), passage({ chunk_id: 'c' })]])
    assert.deepEqual(
      indexed.map((p) => [p.index, p.findingIndex, p.passage.chunk_id]),
      [
        [1, 0, 'a'],
        [2, 1, 'b'],
        [3, 1, 'c'],
      ],
    )
  })

  it('maps a cited index to that passage', () => {
    const indexed = indexPassages([
      [passage({ source_ref: 'https://example.com/one', title: 'One' })],
      [passage({ chunk_id: 'b', source_ref: 'https://example.com/two', title: 'Two', source_type: 'email' })],
    ])
    assert.deepEqual(sourcesFor([2], indexed), [
      { title: 'Two', source_ref: 'https://example.com/two', source_type: 'email' },
    ])
  })

  it('drops an index that is out of range, and one that is zero', () => {
    const indexed = indexPassages([[passage()]])
    assert.deepEqual(sourcesFor([0, 2, 99, -1], indexed), [])
  })

  it('drops a passage with no reference to link to', () => {
    const indexed = indexPassages([[passage({ source_ref: null })]])
    assert.deepEqual(sourcesFor([1], indexed), [])
  })

  it('cites one document once when two of its chunks were used', () => {
    const indexed = indexPassages([
      [
        passage({ chunk_id: 'a', source_ref: 'https://example.com/same', title: 'Same' }),
        passage({ chunk_id: 'b', source_ref: 'https://example.com/same', title: 'Same' }),
      ],
    ])
    assert.equal(sourcesFor([1, 2], indexed).length, 1)
  })

  it('returns nothing for no citations', () => {
    assert.deepEqual(sourcesFor([], indexPassages([[passage()]])), [])
  })
})

// ─── The publish checks ─────────────────────────────────────────────────────

describe('sanitiseRecommendation', () => {
  it('keeps a recommendation that opens with the agency voice', () => {
    assert.equal(
      sanitiseRecommendation('We recommend capping broad match with a target return.'),
      'We recommend capping broad match with a target return.',
    )
  })

  it('drops one that does not open with "We recommend"', () => {
    assert.equal(sanitiseRecommendation('You should cap broad match.'), null)
    assert.equal(sanitiseRecommendation('The finding is wrong.'), null)
    assert.equal(sanitiseRecommendation(''), null)
  })

  it('drops "We recommended" and other near misses', () => {
    assert.equal(sanitiseRecommendation('We recommendation capping it.'), null)
  })

  it('strips an em dash and an en dash', () => {
    assert.equal(
      sanitiseRecommendation('We recommend exact match first — then a target return.'),
      'We recommend exact match first, then a target return.',
    )
    assert.equal(
      sanitiseRecommendation('We recommend exact match – then a target.'),
      'We recommend exact match, then a target.',
    )
  })

  it('turns a dash between two figures into "to", so one number does not become two', () => {
    assert.equal(
      sanitiseRecommendation('We recommend holding broad match at 20–25% of spend.'),
      'We recommend holding broad match at 20 to 25% of spend.',
    )
  })

  it('checks the opening after the dashes are stripped', () => {
    assert.equal(sanitiseRecommendation('  We recommend acting now.  '), 'We recommend acting now.')
  })
})

// ─── The whole job ──────────────────────────────────────────────────────────

describe('buildRecommendations', () => {
  it('returns one entry per finding, in order, matched by code', async () => {
    const findings = [B2, { ...B2, code: 'C1' }, { ...B2, code: 'D4' }]
    const result = await buildRecommendations(
      { ...request, findings },
      deps({
        generate: async () => [
          { code: 'D4', recommendation: 'We recommend D4 work.', source_indexes: [] },
          { code: 'B2', recommendation: 'We recommend B2 work.', source_indexes: [] },
        ],
      }),
    )
    assert.deepEqual(
      result.map((r) => [r.code, r.recommendation]),
      [
        ['B2', 'We recommend B2 work.'],
        ['C1', null],
        ['D4', 'We recommend D4 work.'],
      ],
    )
  })

  it('embeds every query in one call', async () => {
    const calls: string[][] = []
    await buildRecommendations(
      { ...request, findings: [B2, { ...B2, code: 'C1' }] },
      deps({
        embedQueries: async (texts) => {
          calls.push(texts)
          return texts.map(() => [0.1])
        },
      }),
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].length, 2)
  })

  it('builds the query from the channel label, the title and the action', () => {
    assert.equal(
      queryFor('google_ads', B2),
      'Google Ads: Broad match is uncapped and converting queries are uncovered. Add phrase or exact keywords for converting queries, and cap broad match with a target or prune it.',
    )
  })

  it('leaves the action out of the query when the finding has none', () => {
    assert.equal(queryFor('merchant_center', { ...B2, action: undefined }), `Merchant Center: ${B2.title}.`)
  })

  it('humanises a channel it has no label for', () => {
    assert.equal(queryFor('tiktok_ads', { ...B2, action: undefined }), `tiktok ads: ${B2.title}.`)
  })

  it('attaches the sources the model cited', async () => {
    const result = await buildRecommendations(request, deps())
    assert.deepEqual(result[0].sources, [
      { title: 'Match types and budget control', source_ref: 'https://example.com/one', source_type: 'youtube' },
    ])
  })

  it('returns no sources when the model cited none', async () => {
    const result = await buildRecommendations(
      request,
      deps({
        generate: async () => [{ code: 'B2', recommendation: 'We recommend general practice.', source_indexes: [] }],
      }),
    )
    assert.deepEqual(result[0].sources, [])
  })

  it('returns no sources for a recommendation it dropped, even if the model cited some', async () => {
    const result = await buildRecommendations(
      request,
      deps({
        generate: async () => [{ code: 'B2', recommendation: 'The threshold looks wrong.', source_indexes: [1] }],
      }),
    )
    assert.equal(result[0].recommendation, null)
    assert.deepEqual(result[0].sources, [])
  })

  it('goes to the model with no passages when nothing clears the floor', async () => {
    let user = ''
    const result = await buildRecommendations(
      request,
      deps({
        searchKnowledge: async () => [row({ similarity: 0.1 })],
        generate: async (args) => {
          user = args.user
          return [{ code: 'B2', recommendation: 'We recommend general practice.', source_indexes: [1] }]
        },
      }),
    )
    assert.match(user, /Passages: none/)
    // Nothing was shown, so a citation resolves to nothing.
    assert.deepEqual(result[0].sources, [])
    assert.equal(result[0].recommendation, 'We recommend general practice.')
  })

  it('carries on without passages when a search fails', async () => {
    const lines: string[] = []
    const result = await buildRecommendations(
      request,
      deps({
        searchKnowledge: async () => {
          throw new Error('Supabase is down')
        },
        log: (line) => lines.push(line),
        generate: async () => [{ code: 'B2', recommendation: 'We recommend general practice.', source_indexes: [] }],
      }),
    )
    assert.equal(result[0].recommendation, 'We recommend general practice.')
    assert.ok(lines.some((l) => /Search failed/.test(l)))
  })

  it('throws a tagged error when Voyage fails', async () => {
    await assert.rejects(
      buildRecommendations(
        request,
        deps({
          embedQueries: async () => {
            throw new Error('Voyage is down')
          },
        }),
      ),
      (error: unknown) => error instanceof RecommendError && error.stage === 'embedding',
    )
  })

  it('throws a tagged error when Anthropic fails', async () => {
    await assert.rejects(
      buildRecommendations(
        request,
        deps({
          generate: async () => {
            throw new Error('Anthropic is down')
          },
        }),
      ),
      (error: unknown) => error instanceof RecommendError && error.stage === 'generation',
    )
  })

  it('keeps the words of a finding out of the log', async () => {
    const lines: string[] = []
    await buildRecommendations(request, deps({ log: (line) => lines.push(line) }))
    const logged = lines.join('\n')
    assert.ok(!logged.includes(B2.title))
    assert.ok(!logged.includes(B2.detail))
    assert.ok(!logged.includes('41,200'))
  })
})

// ─── The prompt ─────────────────────────────────────────────────────────────

describe('buildUserTurn', () => {
  it('carries each finding, its action and its examples, with passages numbered', () => {
    const indexed = indexPassages([[passage({ title: 'One' })], [passage({ chunk_id: 'b', title: 'Two' })]])
    const user = buildUserTurn({ ...request, findings: [B2, { ...B2, code: 'C1' }] }, indexed)
    assert.match(user, /Finding B2 \(urgent\)/)
    assert.match(user, /Finding C1 \(urgent\)/)
    assert.match(user, /Action from the checks: Add phrase or exact keywords/)
    assert.match(user, /Examples: barndominium plans, modern farmhouse plans/)
    assert.match(user, /\[1\] One \(youtube\)/)
    assert.match(user, /\[2\] Two \(youtube\)/)
    assert.match(user, /Client: Architectural Designs\. Markets: US, CA\./)
  })

  it('says so when a finding has no action', () => {
    const user = buildUserTurn({ ...request, findings: [{ ...B2, action: undefined }] }, [])
    assert.match(user, /Action from the checks: none given/)
  })

  it('says the markets are not stated when none were sent', () => {
    const user = buildUserTurn({ ...request, client: { name: 'A Client' }, findings: [B2] }, [])
    assert.match(user, /Markets: not stated\./)
  })

  it('gives each finding only its own passages', () => {
    const indexed = indexPassages([[passage({ title: 'First finding doc' })], [passage({ chunk_id: 'b', title: 'Second finding doc' })]])
    const user = buildUserTurn({ ...request, findings: [B2, { ...B2, code: 'C1' }] }, indexed)
    const b2Block = user.slice(user.indexOf('Finding B2'), user.indexOf('Finding C1'))
    assert.match(b2Block, /First finding doc/)
    assert.ok(!b2Block.includes('Second finding doc'))
  })
})
