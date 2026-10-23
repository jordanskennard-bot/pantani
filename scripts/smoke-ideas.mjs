// Smoke test for POST /api/ideas against a deployed Pantani.
//
// Posts the Shopping example from the build brief and prints the reply.
// Nothing is written anywhere: the route stores nothing, and this script only
// reads.
//
//   PANTANI_SERVICE_KEY=... node scripts/smoke-ideas.mjs
//   PANTANI_SERVICE_KEY=... node scripts/smoke-ideas.mjs https://pantani.passoagency.com
//
// Default target is production. Pass a URL to point it at a preview deploy.
//
// What a pass looks like:
//   one entry per section sent, in order; nought to three ideas each; every
//   title opening with a verb; every idea carrying at least one source, dated
//   inside the recency window; and no idea restating a finding title or a
//   previous idea.
//
// Nought ideas everywhere is a valid pass, and the likely one when little has
// been ingested lately. The script says so rather than failing.

const DEFAULT_URL = 'https://pantani.passoagency.com'
const VERBS = ['test', 'try', 'add', 'use', 'trial', 'run', 'switch', 'set up']

const base = (process.argv[2] ?? process.env.PANTANI_URL ?? DEFAULT_URL).replace(/\/$/, '')
const key = process.env.PANTANI_SERVICE_KEY

if (!key) {
  console.error('PANTANI_SERVICE_KEY is not set. Set it to the same value as in Vercel.')
  process.exit(1)
}

const request = {
  channel: 'google_ads',
  client: {
    name: 'Architectural Designs',
    markets: ['US', 'CA'],
    shopify: false,
    in_use: ['search', 'pmax', 'standard_shopping', 'merchant_center', 'customer_match'],
  },
  sections: [
    {
      code: 'S',
      name: 'Shopping',
      checked: 'Your product ads, with a picture and price, and the searches they appear for.',
      finding_titles: ['Approved products outside every listing group'],
    },
    {
      code: 'A',
      name: 'Measurement',
      checked: 'Whether Google Ads records your sales correctly, so it can tell which ads work.',
      finding_titles: ['Purchases are counted more than once per click'],
    },
    {
      code: 'C',
      name: 'Performance Max',
      checked: 'Campaigns where Google places your ads across search, YouTube and other sites.',
      finding_titles: [],
    },
  ],
  previous_ideas: ['Test Shopping ad overlays on your best sellers'],
}

console.log(`POST ${base}/api/ideas`)
console.log(`${request.sections.length} section(s): ${request.sections.map((s) => s.code).join(', ')}`)

const started = Date.now()
let response
try {
  response = await fetch(`${base}/api/ideas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(65_000),
  })
} catch (error) {
  console.error(`The request failed after ${Date.now() - started}ms: ${error.message}`)
  process.exit(1)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`${response.status} ${response.statusText} in ${seconds}s\n`)

const text = await response.text()
let body
try {
  body = JSON.parse(text)
} catch {
  console.error(text.slice(0, 2000))
  process.exit(1)
}

if (!response.ok) {
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

const sections = body.sections ?? []
let total = 0

for (const section of sections) {
  const ideas = section.ideas ?? []
  total += ideas.length
  console.log(`--- ${section.code} (${ideas.length} idea${ideas.length === 1 ? '' : 's'}) ---`)
  for (const idea of ideas) {
    const verb = VERBS.some((v) => idea.title.toLowerCase().startsWith(v))
    const dashes = /[—–]/.test(`${idea.title} ${idea.what} ${idea.how}`)
    console.log(`  ${idea.title}`)
    console.log(`    what: ${idea.what}`)
    console.log(`    how:  ${idea.how}`)
    console.log(`    opens with a verb: ${verb ? 'yes' : 'NO'}`)
    console.log(`    dashes: ${dashes ? 'FOUND' : 'none'}`)
    console.log(`    sources: ${(idea.sources ?? []).length}`)
    for (const source of idea.sources ?? []) {
      console.log(`      ${source.title} (${source.source_type}${source.date ? `, ${source.date}` : ''}) ${source.source_ref}`)
    }
  }
  console.log('')
}

// A repeat is the one failure the reply cannot show on its own, so it is
// checked here against what was sent.
const sent = [
  ...request.previous_ideas.map((t) => t.toLowerCase()),
  ...request.sections.flatMap((s) => (s.finding_titles ?? []).map((t) => t.toLowerCase())),
]
for (const section of sections) {
  for (const idea of section.ideas ?? []) {
    const clash = sent.find((t) => t === idea.title.toLowerCase())
    if (clash) console.error(`REPEAT: ${section.code} returned something already sent: ${idea.title}`)
  }
}

console.log(`${total} idea(s) across ${sections.length} section(s).`)
if (total === 0) {
  console.log('Nought ideas is a valid answer. It usually means little recent material has been ingested,')
  console.log('or nothing recent is close enough to these sections. Check the window and what was ingested.')
}

if (sections.length !== request.sections.length) {
  console.error(`\nExpected ${request.sections.length} entries, got ${sections.length}.`)
  process.exit(1)
}
