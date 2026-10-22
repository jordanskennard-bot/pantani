// Smoke test for POST /api/recommend against a deployed Pantani.
//
// Posts the B2 example from the build brief and prints the reply. Nothing is
// written anywhere: the route stores nothing, and this script only reads.
//
//   PANTANI_SERVICE_KEY=... node scripts/smoke-recommend.mjs
//   PANTANI_SERVICE_KEY=... node scripts/smoke-recommend.mjs https://pantani.passoagency.com
//
// Default target is production. Pass a URL to point it at a preview deploy.
//
// What a pass looks like:
//   one recommendation per finding sent, each opening "We recommend", every
//   figure from the finding unchanged, and real sources or none.

const DEFAULT_URL = 'https://pantani.passoagency.com'

const base = (process.argv[2] ?? process.env.PANTANI_URL ?? DEFAULT_URL).replace(/\/$/, '')
const key = process.env.PANTANI_SERVICE_KEY

if (!key) {
  console.error('PANTANI_SERVICE_KEY is not set. Set it to the same value as in Vercel.')
  process.exit(1)
}

const request = {
  channel: 'google_ads',
  client: { name: 'Architectural Designs', markets: ['US', 'CA'] },
  findings: [
    {
      code: 'B2',
      severity: 'urgent',
      title: 'Broad match is uncapped and converting queries are uncovered',
      detail:
        '62% of keyword spend ($41,200) is on broad match without a cost or return target. We recommend keeping that under 25%. 8 of the top 20 converting queries have phrase or exact cover.',
      action: 'Add phrase or exact keywords for converting queries, and cap broad match with a target or prune it.',
      examples: ['barndominium plans', 'modern farmhouse plans'],
    },
  ],
}

console.log(`POST ${base}/api/recommend`)
console.log(`${request.findings.length} finding(s): ${request.findings.map((f) => f.code).join(', ')}`)

const started = Date.now()
let response
try {
  response = await fetch(`${base}/api/recommend`, {
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

for (const entry of body.recommendations ?? []) {
  console.log(`--- ${entry.code} ---`)
  if (entry.recommendation === null) {
    console.log('  no recommendation (the model left it out, or what it wrote was dropped)')
  } else {
    console.log(`  ${entry.recommendation}`)
    const opens = /^We recommend\b/.test(entry.recommendation)
    console.log(`  opens "We recommend": ${opens ? 'yes' : 'NO'}`)
    const dashes = /[—–]/.test(entry.recommendation)
    console.log(`  dashes: ${dashes ? 'FOUND' : 'none'}`)
  }
  const sources = entry.sources ?? []
  console.log(`  sources: ${sources.length}`)
  for (const source of sources) {
    console.log(`    ${source.title} (${source.source_type}) ${source.source_ref}`)
  }
  console.log('')
}

// The figures in the finding must come back untouched, so they are worth
// eyeballing side by side with what was written.
console.log('Figures in the finding sent, for comparison with the text above:')
for (const finding of request.findings) {
  const figures = finding.detail.match(/[£$€]?[\d][\d,.]*%?/g) ?? []
  console.log(`  ${finding.code}: ${figures.join(', ')}`)
}

const count = (body.recommendations ?? []).length
if (count !== request.findings.length) {
  console.error(`\nExpected ${request.findings.length} entries, got ${count}.`)
  process.exit(1)
}
