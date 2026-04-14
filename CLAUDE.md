@AGENTS.md
@../BRAND.md

# Pantani — Libro di corsa

Pantani is the knowledge layer of **Passo**, an autonomous programmatic media agency for Shopify DTC merchants in the UK. The name comes from Marco Pantani; "libro di corsa" is Italian for race book — the knowledge base agents consult when making decisions.

Pantani is a RAG (Retrieval Augmented Generation) knowledge store. You feed it documents, emails, and URLs. It classifies, chunks, and embeds them. Specialist agents query it to inform media decisions.

---

## What Passo is

Passo connects to a merchant's Shopify store, studies their business, builds a media strategy, executes that strategy across programmatic channels, and delivers a monthly narrative report — without requiring the merchant to understand programmatic advertising or manage campaigns.

**Three core differentiators:**
1. **New customer only** — Passo never retargets. Every impression targets people who have never bought from the merchant. New customer count, verified against Shopify order history, is the primary metric.
2. **Shopify as single source of truth** — the merchant's store is the brief. All results are reconciled against actual Shopify revenue, not platform-reported ROAS figures (which systematically overcount via view-through attribution).
3. **Transparent strategy** — before spending a pound, the merchant approves a complete strategy with projected ROAS range, format mix, and audience rationale. Every month a narrative report explains what happened and why.

**Business model:** principal-based media buying. Passo buys inventory at cost and charges merchants a blended rate that includes the margin. As cross-merchant learning improves buying efficiency, costs fall at the same merchant-facing price — margin widens automatically.

**Why now:** PubMatic launched AgenticOS in January 2026 — the first production implementation of agentic RTB accessible to small advertisers without a trading desk. This removes the primary technical barrier. Passo is built on top of it.

---

## The technology layer

**AgenticOS (PubMatic)** — the programmatic execution layer. An implementation of the Agentic Real Time Framework (ARTF). Enables autonomous real-time bidding without a DSP relationship or trading desk.

**AdCP (Ads Context Protocol)** — the buying standard Passo uses to purchase directly from premium publishers, bypassing open RTB exchanges where fraud, wastage, and brand safety failures are endemic.

**Claude API (Sonnet)** — powers the intelligence layer: watching period analysis, strategy generation, and monthly narrative writing.

**Cross-merchant learning layer** — every campaign outcome feeds a shared dataset of which publishers, formats, and audience signals drive verified new customer acquisition for which product categories at which spend levels. This is the structural moat.

---

## Agent architecture

Internal agents are named after Alpine climbs. These names are internal only — no cycling language appears in merchant-facing communication.

| Agent | Role |
|---|---|
| **Pantani** | Orchestration layer — coordinator, memory, reflection |
| **Galibier** | Strategy — media planning, channel mix, budget allocation |
| **Stelvio** | Execution — campaign management, bid optimisation |
| **Mortirolo** | Anomaly detection — performance monitoring, alerting |
| **Gavia** | Attribution — Shopify reconciliation, ROAS verification |
| **Izoard** | Audience intelligence — targeting, signals, lookalikes |
| **Tourmalet** | Narrative — monthly report writing, merchant communication |

Galibier, Gavia, Izoard, and Tourmalet are the primary consumers of Pantani's knowledge store.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js App Router, Node.js runtime |
| Database | Supabase (Postgres + pgvector) |
| Embeddings | Voyage AI `voyage-3-lite` (512 dimensions) — direct fetch, no SDK |
| Comprehension | Anthropic Claude `claude-haiku-4-5-20251001` — via `@anthropic-ai/sdk` |
| PDF extraction | `unpdf` (not pdf-parse — broken in Next.js) |
| DOCX extraction | `mammoth` |
| HTML scraping | `cheerio` |
| Deployment | Vercel — live at `pantani.passo.ad` |

---

## Ingestion pipeline

Every piece of knowledge follows the same path through `src/lib/ingest.ts`:

1. **Duplicate check** — MD5 hash of raw text, checked against `documents.content_hash`. Returns immediately if already stored. No API calls wasted.
2. **Classify** — one Claude Haiku call: produces a summary, 3-8 key_insights (specific facts/stats extracted from the document), and tags from the fixed vocabulary.
3. **Store document** — inserts into `documents` table with summary, key_insights, tags, content_hash, raw_text.
4. **Chunk** — splits text into ~500-token overlapping chunks (`src/lib/chunk.ts`).
5. **Contextualise** — one Claude Haiku call for the whole document: generates an insight-focused prefix per chunk identifying the key fact or claim in that chunk (not just its location). Embedded with the chunk to improve retrieval of specific data points.
6. **Embed** — Voyage AI embeds `context_prefix + chunk` text. Batched at 64 with 20s delay between batches (free tier is 3 RPM).
7. **Store chunks** — inserts into `chunks` table with content, context_prefix, and embedding vector.

---

## Intake channels

| Channel | Route | How it works |
|---|---|---|
| File drop | `POST /api/ingest/file` | PDF, DOCX, TXT, MD up to 20MB. Multiple files queue sequentially in the UI. |
| URL | `POST /api/ingest/url` | Fetches page, strips boilerplate with cheerio, follows redirects. Also handles PDF URLs. |
| Email | `POST /api/ingest/email` | Webhook from Resend. Ingests email body + follows all http/https links. Secret passed as `?key=` query param. |
| YouTube channel | `POST /api/ingest/youtube-channel` | Bulk-ingests transcripts from a channel. Body: `{ "channel": "@handle or URL" }`. Skips already-ingested videos. |
| YouTube poll | `GET /api/poll-youtube` | Ingests new videos within `YOUTUBE_LOOKBACK_DAYS` from channels in `YOUTUBE_CHANNEL_IDS`. For Vercel cron. |

**Email routing:** `pantani@passo.ad` (Zoho alias) → forwarded to `pantani@in.passo.ad` → received by Resend → POSTed to `/api/ingest/email`.

---

## Database schema

**`documents`** — one row per ingested item
- `id`, `created_at`, `source_type` (email/file/url/youtube), `source_ref`, `source_from`, `title`
- `raw_text` — full extracted text
- `token_count` — rough estimate (chars / 4)
- `summary` — Claude's 2-3 sentence classification
- `key_insights` — text[] of 3-8 specific facts, stats, and claims extracted at ingest
- `tags` — text[] from fixed vocabulary (GIN indexed)
- `content_hash` — md5(raw_text), unique constraint prevents duplicates
- `metadata` — jsonb for file size, mime type, domain etc.

**`chunks`** — many rows per document
- `document_id` → documents(id) on delete cascade
- `chunk_index`, `content` — raw chunk text
- `context_prefix` — Claude's insight-focused prefix: the key fact or claim in this chunk
- `embedding` — vector(512), IVFFlat indexed for cosine similarity search

**`search_knowledge()`** — RPC function for vector search, supports filtering by `source_type` and `tags[]`. Returns document-level `key_insights` alongside each chunk so the Ask route can present both extracted insights and specific passages to Claude Sonnet for synthesis.

---

## Tag vocabulary

Full set — do not change without updating `src/lib/comprehend.ts` and informing agents:

| Tag | What it covers |
|---|---|
| `competitive_intel` | Triple Whale, Criteo GO, AdRoll, Meta, Google — competitors and adjacent platforms |
| `programmatic` | How programmatic buying works — DSPs, SSPs, RTB, inventory types, ad formats |
| `cpm_benchmarks` | CPM pricing data, floor prices, rate cards, cost benchmarks by format/channel/vertical |
| `attribution` | ROAS methodologies, last-click vs view-through, MTA, MMM, platform attribution models |
| `audience` | Targeting, audience signals, lookalikes, intent scoring, contextual targeting |
| `merchant_profile` | DTC merchant behaviour, psychology, paid media maturity, spend patterns |
| `category_knowledge` | Vertical-specific knowledge — homeware, fashion, skincare, consumer goods |
| `platform_intel` | PubMatic, AgenticOS, Meta Ads, Google Ads, specific platform mechanics |
| `regulation` | GDPR, brand safety, IAB standards, consent, ISBA/ANA governance |
| `adcp` | Ads Context Protocol — agentic direct buying from premium publishers outside open RTB |
| `artf` | Agentic Real Time Framework — autonomous real-time programmatic execution by AI agents |
| `agentic` | AI agents in media buying, autonomous campaign management, IAB Agent Registry |
| `new_customer` | New customer acquisition, prospecting, new-to-brand targeting, incremental reach |
| `incrementality` | Lift studies, causal attribution, verifying media spend drove sales vs organic |
| `shopify` | Shopify platform specifics, revenue reconciliation, order data, merchant store structure |

---

## Environment variables

Set in `.env.local` locally, and in Vercel project settings for production. All must be present or the server will fail silently.

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Project URL from Supabase settings |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (not anon key) — has full DB access |
| `VOYAGE_API_KEY` | Voyage AI key for embeddings |
| `ANTHROPIC_API_KEY` | Anthropic key for Claude Haiku |
| `INBOUND_EMAIL_SECRET` | Shared secret for webhook auth — passed as `?key=` in the Resend webhook URL |
| `NEXT_PUBLIC_INBOUND_EMAIL` | Display email shown in UI (`pantani@passo.ad`) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (Google Cloud Console) |
| `YOUTUBE_CHANNEL_IDS` | Comma-separated channels for `/api/poll-youtube` |
| `YOUTUBE_LOOKBACK_DAYS` | How far back the poll route looks for new videos (default `7`) |
| `SUPADATA_API_KEY` | Supadata API key for YouTube transcript fetching (bypasses Vercel/AWS IP blocks) |

---

## Key decisions and why

**Voyage AI via direct fetch, not SDK** — the `voyageai` npm SDK has a broken ESM bundle in Next.js (`Module not found: Can't resolve '../Client'`). Direct fetch to `https://api.voyageai.com/v1/embeddings` works fine.

**Anthropic SDK initialised lazily** — `new Anthropic()` must be called inside a function, not at module level. Module-level initialisation runs before Next.js injects env vars, causing authentication failures.

**`unpdf` not `pdf-parse`** — pdf-parse v2 changed to a class-based API that breaks in the Next.js server context. `unpdf` is a drop-in replacement that works.

**`serverExternalPackages: ['@anthropic-ai/sdk']`** in `next.config.ts` — prevents Webpack from bundling the Anthropic SDK, which breaks its Node.js-native internals.

**Sequential file processing** — the UI queues multiple files and processes them one at a time. This avoids parallel Voyage AI calls hitting the 3 RPM free-tier rate limit.

**Contextual retrieval** — each chunk is embedded as `context_prefix + chunk_text`, not just the raw chunk. This significantly improves retrieval accuracy for long documents where individual chunks lack context. The raw chunk is stored separately so agents receive clean text.

**Inbound email via Resend subdomain** — `in.passo.ad` has its own MX record pointing to Resend's inbound SMTP. This leaves the main `passo.ad` Zoho MX records untouched. The webhook secret is passed as `?key=` in the URL because Resend inbound does not support custom request headers.

**YouTube transcript via Supadata** — Vercel runs in AWS datacenters; YouTube blocks transcript requests from those IPs. Supadata proxies the request transparently. Free tier is 100 credits/month — sufficient for ongoing polls but bulk channel imports of 100+ videos need a paid plan.

**YouTube dedup by `source_ref`** — YouTube videos are checked against `documents.source_ref` (the watch URL) before fetching any transcript. Cheaper than the MD5 hash check and avoids unnecessary Supadata API calls on re-polls.
