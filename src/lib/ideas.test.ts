// Unit tests for the ideas route's work. The Voyage, Supabase and Anthropic
// calls are injected, so nothing here reaches the network. The clock is
// injected too, so the recency window can be tested without waiting.
//
// Run with: npm test

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_WINDOW_DAYS,
  IdeasError,
  IdeasRequestSchema,
  MAX_IDEAS,
  MAX_PASSAGES,
  MIN_SIMILARITY,
  buildIdeas,
  buildUserTurn,
  cutoffFrom,
  dateOf,
  indexPassages,
  opensWithVerb,
  queryFor,
  readIdea,
  selectPassages,
  sourcesFor,
  stripDashes,
  windowDays,
  withinWindow,
  type IdeasDeps,
  type IdeasRequest,
  type Passage,
  type SearchRow,
} from './ideas.ts'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-23T12:00:00.000Z')
/** 120 days before NOW is 25 June 2026. */
const CUTOFF = cutoffFrom(NOW, DEFAULT_WINDOW_DAYS)

const SHOPPING = {
  code: 'S',
  name: 'Shopping',
  checked: 'Your product ads, with a picture and price, and the searches they appear for.',
  finding_titles: ['Approved products outside every listing group'],
}

const request: IdeasRequest = {
  channel: 'google_ads',
  client: {
    name: 'Architectural Designs',
    markets: ['US', 'CA'],
    shopify: false,
    in_use: ['search', 'pmax', 'standard_shopping', 'merchant_center', 'customer_match'],
  },
  sections: [SHOPPING],
  previous_ideas: ['Test Shopping ad overlays on your best sellers'],
}

function row(over: Partial<SearchRow> = {}): SearchRow {
  return {
    chunk_id: 'chunk-1',
    document_id: 'doc-1',
    source_type: 'newsletter',
    source_ref: 'https://example.com/one',
    title: 'What is new in Shopping ads',
    key_insights: ['Shopping ad overlays are in open beta for all retailers.'],
    content: 'Overlays put a promotion badge on a product ad.',
    document_date: '2026-09-30T00:00:00.000Z',
    similarity: 0.8,
    ...over,
  }
}

function passage(over: Partial<Passage> = {}): Passage {
  return {
    chunk_id: 'chunk-1',
    title: 'What is new in Shopping ads',
    source_ref: 'https://example.com/one',
    source_type: 'newsletter',
    date: '2026-09-30',
    key_insights: [],
    content: 'Overlays put a promotion badge on a product ad.',
    ...over,
  }
}

const GOOD_IDEA = {
  title: 'Test promotion badges on your best sellers',
  what: 'A badge sits on the product ad showing an offer. It can lift the share of people who click.',
  how: 'Run it on your ten best sellers for a month and compare clicks against the rest of the range.',
  source_indexes: [1],
}

/** Deps that succeed, with the clock fixed and the search and model swappable. */
function deps(over: Partial<IdeasDeps> = {}): IdeasDeps {
  return {
    embedQueries: async (texts) => texts.map((_text, i) => [i, 0.2]),
    searchKnowledge: async () => [row()],
    generate: async () => [{ code: 'S', ideas: [GOOD_IDEA] }],
    env: {},
    now: NOW,
    ...over,
  }
}

// ─── Input validation ───────────────────────────────────────────────────────

describe('IdeasRequestSchema', () => {
  it('accepts the Shopping example', () => {
    assert.equal(IdeasRequestSchema.safeParse(request).success, true)
  })

  it('accepts a request with no previous ideas and no in_use', () => {
    const parsed = IdeasRequestSchema.safeParse({
      channel: 'merchant_center',
      client: { name: 'A Client' },
      sections: [{ code: 'A', name: 'Account health', checked: 'Standing with Google.' }],
    })
    assert.equal(parsed.success, true)
  })

  it('refuses no sections at all', () => {
    assert.equal(IdeasRequestSchema.safeParse({ ...request, sections: [] }).success, false)
  })

  it('refuses more than twenty sections', () => {
    const sections = Array.from({ length: 21 }, (_v, i) => ({ ...SHOPPING, code: `S${i}` }))
    assert.equal(IdeasRequestSchema.safeParse({ ...request, sections }).success, false)
  })

  it('refuses more than forty in_use entries', () => {
    const in_use = Array.from({ length: 41 }, (_v, i) => `feature-${i}`)
    assert.equal(IdeasRequestSchema.safeParse({ ...request, client: { ...request.client, in_use } }).success, false)
  })

  it('refuses more than thirty previous ideas', () => {
    const previous_ideas = Array.from({ length: 31 }, (_v, i) => `Test idea ${i}`)
    assert.equal(IdeasRequestSchema.safeParse({ ...request, previous_ideas }).success, false)
  })
})

// ─── The recency window ─────────────────────────────────────────────────────

describe('windowDays', () => {
  it('defaults to 120 days when unset or empty', () => {
    assert.equal(windowDays({}), DEFAULT_WINDOW_DAYS)
    assert.equal(windowDays({ PANTANI_IDEAS_WINDOW_DAYS: '  ' }), DEFAULT_WINDOW_DAYS)
  })

  it('reads a positive whole number', () => {
    assert.equal(windowDays({ PANTANI_IDEAS_WINDOW_DAYS: '30' }), 30)
  })

  it('falls back to the default on anything else, rather than failing the request', () => {
    assert.equal(windowDays({ PANTANI_IDEAS_WINDOW_DAYS: 'soon' }), DEFAULT_WINDOW_DAYS)
    assert.equal(windowDays({ PANTANI_IDEAS_WINDOW_DAYS: '0' }), DEFAULT_WINDOW_DAYS)
    assert.equal(windowDays({ PANTANI_IDEAS_WINDOW_DAYS: '-30' }), DEFAULT_WINDOW_DAYS)
    assert.equal(windowDays({ PANTANI_IDEAS_WINDOW_DAYS: '7.5' }), DEFAULT_WINDOW_DAYS)
  })
})

describe('withinWindow', () => {
  it('keeps a document inside the window', () => {
    assert.equal(withinWindow({ document_date: '2026-09-30T00:00:00.000Z' }, CUTOFF), true)
  })

  it('drops a document older than the window', () => {
    assert.equal(withinWindow({ document_date: '2026-01-04T00:00:00.000Z' }, CUTOFF), false)
  })

  it('keeps a document dated exactly on the cutoff', () => {
    assert.equal(withinWindow({ document_date: CUTOFF.toISOString() }, CUTOFF), true)
  })

  it('drops a document with no date, so an unmigrated database yields no ideas', () => {
    assert.equal(withinWindow({ document_date: null }, CUTOFF), false)
    assert.equal(withinWindow({ document_date: undefined }, CUTOFF), false)
    assert.equal(withinWindow({ document_date: '' }, CUTOFF), false)
  })

  it('drops a document whose date cannot be read', () => {
    assert.equal(withinWindow({ document_date: 'last Tuesday' }, CUTOFF), false)
  })
})

describe('dateOf', () => {
  it('gives the day, without the time', () => {
    assert.equal(dateOf({ document_date: '2026-09-30T11:22:33.000Z' }), '2026-09-30')
  })

  it('gives null when there is no usable date', () => {
    assert.equal(dateOf({ document_date: null }), null)
    assert.equal(dateOf({ document_date: 'whenever' }), null)
  })
})

// ─── Retrieval ──────────────────────────────────────────────────────────────

describe('queryFor', () => {
  it('names the channel and the section, and asks for what is new', () => {
    assert.equal(queryFor('google_ads', SHOPPING), 'Google Ads Shopping: new features, betas, tests and tactics')
  })

  it('humanises a channel it does not know', () => {
    assert.equal(queryFor('reddit_ads', SHOPPING), 'reddit ads Shopping: new features, betas, tests and tactics')
  })
})

describe('selectPassages', () => {
  it('keeps a recent, relevant passage', () => {
    const passages = selectPassages([row()], CUTOFF)
    assert.equal(passages.length, 1)
    assert.equal(passages[0].date, '2026-09-30')
    assert.deepEqual(passages[0].key_insights, ['Shopping ad overlays are in open beta for all retailers.'])
  })

  it('drops a passage below the similarity floor', () => {
    assert.deepEqual(selectPassages([row({ similarity: MIN_SIMILARITY - 0.01 })], CUTOFF), [])
  })

  it('keeps a passage exactly on the similarity floor', () => {
    assert.equal(selectPassages([row({ similarity: MIN_SIMILARITY })], CUTOFF).length, 1)
  })

  it('drops a relevant passage from outside the window', () => {
    assert.deepEqual(selectPassages([row({ document_date: '2025-12-01T00:00:00.000Z' })], CUTOFF), [])
  })

  it('drops a relevant passage with no date', () => {
    assert.deepEqual(selectPassages([row({ document_date: null })], CUTOFF), [])
  })

  it('dedupes by chunk id', () => {
    assert.equal(selectPassages([row(), row()], CUTOFF).length, 1)
  })

  it('keeps the best when there are more than the cap', () => {
    const rows = Array.from({ length: MAX_PASSAGES + 4 }, (_v, i) =>
      row({ chunk_id: `chunk-${i}`, similarity: 0.4 + i / 100 }),
    )
    const passages = selectPassages(rows, CUTOFF)
    assert.equal(passages.length, MAX_PASSAGES)
    // The highest similarity is the last row generated, so it must lead.
    assert.equal(passages[0].chunk_id, `chunk-${MAX_PASSAGES + 3}`)
  })

  it('falls back to the reference, then to Untitled, for a passage with no title', () => {
    assert.equal(selectPassages([row({ title: null })], CUTOFF)[0].title, 'https://example.com/one')
    assert.equal(selectPassages([row({ title: null, source_ref: null })], CUTOFF)[0].title, 'Untitled')
  })
})

// ─── The prompt ─────────────────────────────────────────────────────────────

describe('indexPassages', () => {
  it('numbers every passage once across the batch, from one', () => {
    const indexed = indexPassages([[passage({ chunk_id: 'a' })], [passage({ chunk_id: 'b' }), passage({ chunk_id: 'c' })]])
    assert.deepEqual(
      indexed.map((p) => [p.index, p.sectionIndex, p.passage.chunk_id]),
      [
        [1, 0, 'a'],
        [2, 1, 'b'],
        [3, 1, 'c'],
      ],
    )
  })
})

describe('buildUserTurn', () => {
  it('carries the client, what it runs, the findings and the previous ideas', () => {
    const indexed = indexPassages([[passage()]])
    const turn = buildUserTurn(request, [SHOPPING], indexed)
    assert.match(turn, /Channel: Google Ads/)
    assert.match(turn, /Markets: US, CA/)
    assert.match(turn, /Sells on Shopify: no/)
    assert.match(turn, /Already running: search, pmax, standard_shopping, merchant_center, customer_match\./)
    assert.match(turn, /Do not repeat these:/)
    assert.match(turn, /Test Shopping ad overlays on your best sellers/)
    assert.match(turn, /--- Section S: Shopping ---/)
    assert.match(turn, /Approved products outside every listing group/)
    assert.match(turn, /\[1\] What is new in Shopping ads \(newsletter, 2026-09-30\)/)
  })

  it('says a market and a shop are not stated when they are not given', () => {
    const turn = buildUserTurn(
      { channel: 'google_ads', client: { name: 'A Client' }, sections: [SHOPPING] },
      [SHOPPING],
      indexPassages([[passage()]]),
    )
    assert.match(turn, /Markets: not stated/)
    assert.match(turn, /Sells on Shopify: not stated/)
    assert.match(turn, /Already running: not stated\./)
  })
})

// ─── The backstops ──────────────────────────────────────────────────────────

describe('opensWithVerb', () => {
  it('accepts every verb on the allow list, in any case', () => {
    for (const title of ['Test this', 'Try this', 'Add this', 'Use this', 'Trial this', 'Run this', 'Switch this', 'Set up this', 'TEST this']) {
      assert.equal(opensWithVerb(title), true, title)
    }
  })

  it('refuses a title that is not an instruction', () => {
    assert.equal(opensWithVerb('Shopping ad overlays'), false)
    assert.equal(opensWithVerb('Consider overlays on your best sellers'), false)
    assert.equal(opensWithVerb('Testing overlays'), false)
  })
})

describe('stripDashes', () => {
  it('turns a dash between figures into "to", so one range stays one range', () => {
    assert.equal(stripDashes('Expect 10–20 clicks.'), 'Expect 10 to 20 clicks.')
  })

  it('turns a dash elsewhere into a comma', () => {
    assert.equal(stripDashes('Overlays — in beta — can help.'), 'Overlays, in beta, can help.')
  })
})

describe('sourcesFor', () => {
  it('maps a cited index to its passage, with the date', () => {
    const indexed = indexPassages([[passage()]])
    assert.deepEqual(sourcesFor([1], indexed), [
      { title: 'What is new in Shopping ads', source_ref: 'https://example.com/one', source_type: 'newsletter', date: '2026-09-30' },
    ])
  })

  it('leaves the date off a passage that has none', () => {
    const indexed = indexPassages([[passage({ date: null })]])
    assert.deepEqual(sourcesFor([1], indexed), [
      { title: 'What is new in Shopping ads', source_ref: 'https://example.com/one', source_type: 'newsletter' },
    ])
  })

  it('drops an index that is out of range', () => {
    assert.deepEqual(sourcesFor([9], indexPassages([[passage()]])), [])
  })

  it('drops a passage with nothing to link to', () => {
    assert.deepEqual(sourcesFor([1], indexPassages([[passage({ source_ref: null })]])), [])
  })

  it('cites one document once, however many of its chunks were used', () => {
    const indexed = indexPassages([[passage({ chunk_id: 'a' }), passage({ chunk_id: 'b' })]])
    assert.equal(sourcesFor([1, 2], indexed).length, 1)
  })
})

describe('readIdea', () => {
  const indexed = indexPassages([[passage()]])

  it('publishes a good idea with its sources', () => {
    const idea = readIdea(GOOD_IDEA, indexed)
    assert.equal(idea?.title, 'Test promotion badges on your best sellers')
    assert.equal(idea?.sources.length, 1)
  })

  it('drops an idea whose title does not open with a verb', () => {
    assert.equal(readIdea({ ...GOOD_IDEA, title: 'Promotion badges' }, indexed), null)
  })

  it('drops an idea that cites nothing', () => {
    assert.equal(readIdea({ ...GOOD_IDEA, source_indexes: [] }, indexed), null)
  })

  it('drops an idea whose every citation is unusable', () => {
    assert.equal(readIdea({ ...GOOD_IDEA, source_indexes: [42] }, indexed), null)
  })

  it('drops an idea missing its what or its how', () => {
    assert.equal(readIdea({ ...GOOD_IDEA, what: '' }, indexed), null)
    assert.equal(readIdea({ ...GOOD_IDEA, how: '   ' }, indexed), null)
  })

  it('strips dashes from every field', () => {
    const idea = readIdea({ ...GOOD_IDEA, what: 'Overlays — in beta — can help.' }, indexed)
    assert.equal(idea?.what, 'Overlays, in beta, can help.')
  })
})

// ─── The whole job ──────────────────────────────────────────────────────────

describe('buildIdeas', () => {
  it('returns one entry per section sent, in order', async () => {
    const two: IdeasRequest = { ...request, sections: [SHOPPING, { ...SHOPPING, code: 'A', name: 'Measurement' }] }
    const sections = await buildIdeas(two, deps())
    assert.deepEqual(
      sections.map((s) => s.code),
      ['S', 'A'],
    )
  })

  it('gives a section the model answered its ideas', async () => {
    const [shopping] = await buildIdeas(request, deps())
    assert.equal(shopping.ideas.length, 1)
    assert.equal(shopping.ideas[0].title, 'Test promotion badges on your best sellers')
  })

  it('never asks the model when no section has a recent passage, and returns empty lists', async () => {
    let asked = false
    const sections = await buildIdeas(request, deps({
      searchKnowledge: async () => [row({ document_date: '2024-01-01T00:00:00.000Z' })],
      generate: async () => {
        asked = true
        return []
      },
    }))
    assert.equal(asked, false)
    assert.deepEqual(sections, [{ code: 'S', ideas: [] }])
  })

  it('leaves a section with no passages out of the prompt, and still answers for it', async () => {
    const two: IdeasRequest = { ...request, sections: [{ ...SHOPPING, code: 'A', name: 'Measurement' }, SHOPPING] }
    let turn = ''
    const sections = await buildIdeas(two, deps({
      // Only the second section finds anything.
      searchKnowledge: async (embedding) => (embedding[0] === 0 ? [] : [row()]),
      generate: async (args) => {
        turn = args.user
        return [{ code: 'S', ideas: [GOOD_IDEA] }]
      },
    }))
    assert.doesNotMatch(turn, /Section A/)
    assert.match(turn, /Section S/)
    assert.deepEqual(sections.map((s) => [s.code, s.ideas.length]), [['A', 0], ['S', 1]])
  })

  it('carries on when the search fails for a section', async () => {
    const lines: string[] = []
    const sections = await buildIdeas(request, deps({
      searchKnowledge: async () => {
        throw new Error('supabase is down')
      },
      log: (line) => lines.push(line),
    }))
    assert.deepEqual(sections, [{ code: 'S', ideas: [] }])
    assert.ok(lines.some((line) => line.includes('Search failed')))
  })

  it('caps a section at three ideas', async () => {
    const many = Array.from({ length: 6 }, (_v, i) => ({ ...GOOD_IDEA, title: `Test idea number ${i}` }))
    const [shopping] = await buildIdeas(request, deps({ generate: async () => [{ code: 'S', ideas: many }] }))
    assert.equal(shopping.ideas.length, MAX_IDEAS)
  })

  it('drops the ideas that fail the backstops and keeps the rest', async () => {
    const mixed = [
      { ...GOOD_IDEA, title: 'Overlays on best sellers' },
      { ...GOOD_IDEA, source_indexes: [] },
      GOOD_IDEA,
    ]
    const [shopping] = await buildIdeas(request, deps({ generate: async () => [{ code: 'S', ideas: mixed }] }))
    assert.deepEqual(shopping.ideas.map((i) => i.title), ['Test promotion badges on your best sellers'])
  })

  it('gives an idea to the first section only when the model repeats it', async () => {
    const two: IdeasRequest = { ...request, sections: [SHOPPING, { ...SHOPPING, code: 'A', name: 'Measurement' }] }
    const sections = await buildIdeas(two, deps({
      generate: async () => [
        { code: 'S', ideas: [GOOD_IDEA] },
        { code: 'A', ideas: [GOOD_IDEA] },
      ],
    }))
    assert.deepEqual(sections.map((s) => s.ideas.length), [1, 0])
  })

  it('gives a section the model left out an empty list', async () => {
    const [shopping] = await buildIdeas(request, deps({ generate: async () => [] }))
    assert.deepEqual(shopping, { code: 'S', ideas: [] })
  })

  it('asks the database only for documents inside the window', async () => {
    let asked = ''
    await buildIdeas(request, deps({
      searchKnowledge: async (_embedding, after) => {
        asked = after.toISOString()
        return [row()]
      },
    }))
    assert.equal(asked, CUTOFF.toISOString())
  })

  it('narrows the window when the environment says so', async () => {
    let asked = ''
    await buildIdeas(request, deps({
      env: { PANTANI_IDEAS_WINDOW_DAYS: '30' },
      searchKnowledge: async (_embedding, after) => {
        asked = after.toISOString()
        return [row()]
      },
    }))
    assert.equal(asked, cutoffFrom(NOW, 30).toISOString())
  })

  it('throws an embedding error when Voyage fails', async () => {
    await assert.rejects(
      () => buildIdeas(request, deps({ embedQueries: async () => { throw new Error('voyage is down') } })),
      (error: unknown) => error instanceof IdeasError && error.stage === 'embedding',
    )
  })

  it('throws a generation error when Anthropic fails', async () => {
    await assert.rejects(
      () => buildIdeas(request, deps({ generate: async () => { throw new Error('anthropic is down') } })),
      (error: unknown) => error instanceof IdeasError && error.stage === 'generation',
    )
  })
})
