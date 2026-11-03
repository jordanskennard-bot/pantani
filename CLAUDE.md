@AGENTS.md
@../BRAND.md

# Pantani — Libro di corsa

Pantani is Jordan's knowledge bank and the knowledge layer of **Passo**, a UK paid media service for Shopify brands. The name comes from Marco Pantani; "libro di corsa" is Italian for race book.

Pantani is a RAG (Retrieval Augmented Generation) knowledge store. You feed it newsletters, videos, documents, emails and URLs. It classifies, chunks and embeds them. Jordan queries it through Ask, and the Passo health check calls it for recommendations and ideas worth testing.

---

## What Passo is

Passo's single source of truth is the Passo plan in the claude.ai Passo Project (`plan/PLAN.md`, `plan/decisions.md`). Pantani carries a short version of it in `src/lib/passo-context.ts`, which both the ingest classifier and the Ask route use.

When the plan changes:
1. Update `PASSO_CONTEXT` in `src/lib/passo-context.ts`.
2. Bump `PASSO_CONTEXT_VERSION`.
3. Run `scripts/reclassify.ts` (see below) so stored summaries, key insights and tags are rewritten against the new context.

Do not describe Passo anywhere else in this repo. The old positioning (autonomous programmatic buying through PubMatic AgenticOS and AdCP, never retargeting, principal-based buying, the Galibier, Stelvio and Gavia agents) is retired. The climb names survive only as internal agent names in the Passo platform and never appear in Pantani prompts.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js App Router, Node.js runtime |
| Database | Supabase (Postgres + pgvector) |
| Embeddings | Voyage AI `voyage-3-lite` (512 dimensions) — direct fetch, no SDK |
| Ingest comprehension | Anthropic Claude `claude-haiku-4-5-20251001` — classify, summarise, chunk context |
| Ask synthesis | Anthropic Claude `claude-sonnet-4-5` — retrieval synthesis, supplements KB with own knowledge |
| PDF extraction | `unpdf` (not pdf-parse — broken in Next.js) |
| DOCX extraction | `mammoth` |
| HTML scraping | `cheerio` |
| Inbound email | Postmark — receives forwarded emails, POSTs parsed JSON to `/api/ingest/email` |
| Deployment | Vercel project `pantani-sm67` — live at `pantani.passoagency.com` |

---

## Ingestion pipeline

Every piece of knowledge follows the same path through `src/lib/ingest.ts`:

1. **Duplicate check** — MD5 hash of raw text, checked against `documents.content_hash`. Returns immediately if already stored. No API calls wasted.
2. **Classify** — one Claude Haiku call against the Passo context: produces an English summary, 3-8 key_insights (the source's own facts, stats and tactics) and tags from the fixed vocabulary. The context version is recorded in `metadata.passo_context`.
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
| Email | `POST /api/ingest/email` | Webhook from Postmark. Ingests email body, follows all http/https links found in body, and extracts any PDF/DOCX/TXT/MD attachments. Secret passed as `?key=` query param. |
| YouTube channel | `POST /api/ingest/youtube-channel` | Bulk-ingests transcripts from a channel. Body: `{ "channel": "@handle or URL" }`. Skips already-ingested videos. |
| YouTube poll | `GET /api/poll-youtube` | Ingests new videos within `YOUTUBE_LOOKBACK_DAYS` from channels in `YOUTUBE_CHANNEL_IDS`. For Vercel cron. |

## Service routes (called by the Passo health check, not by an operator)

Both authenticate with `PANTANI_SERVICE_KEY` as a bearer token through
`src/lib/service-auth.ts`, are listed in `PUBLIC_PATHS` in `src/middleware.ts`
so the operator login does not intercept them, store nothing from the request,
and log nothing from its body. Each makes one Voyage call and one Anthropic
call (`claude-sonnet-4-5`) for the whole batch.

| Route | What it does |
|---|---|
| `POST /api/recommend` | Takes the health check findings that need action and returns one recommendation per finding, each opening "We recommend". Improves the advice on a finding the coded rules raised, and nothing else: it never grades a finding or touches a number. Work in `src/lib/recommend.ts`. |
| `POST /api/ideas` | Takes the sections of a health check that ran and returns nought to three ideas worth testing for each: new features, betas and tactics the account is not using yet. Covers what the coded rules cannot know about, which is anything new. Every idea must cite a passage from inside the recency window, so there is no general practice fallback. Work in `src/lib/ideas.ts`. |

**Why ideas have no fallback and recommendations do.** A recommendation with no
passage behind it is still useful advice, so `/api/recommend` writes it from
general paid media practice and returns no sources. An idea exists only because
something was learnt lately, so an idea with nothing behind it is not news and
claiming otherwise would misstate where it came from. `/api/ideas` returns
nought ideas instead, which is the common answer and shows nothing extra on the
page.

**Email routing:** any email address (Gmail, Zoho, etc.) → forwarded to Postmark inbound address → Postmark POSTs parsed JSON to `https://pantani.passoagency.com/api/ingest/email?key=INBOUND_EMAIL_SECRET`.

**Postmark inbound format:** `From`, `Subject`, `TextBody`, `HtmlBody`, `Attachments[]` (base64 encoded). The route normalises across Postmark and generic formats.

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

**`search_knowledge()`** — RPC function for vector search, supports filtering by `source_type`, `tags[]` and `filter_after` (migration 007: documents ingested on or after a timestamp). Returns document-level `key_insights` alongside each chunk so the Ask route can present both extracted insights and specific passages to Claude Sonnet for synthesis, plus `document_date` (the document's `created_at`) so a caller can show how old a passage is or apply its own recency rule.

---

## Tag vocabulary

Defined in `src/lib/comprehend.ts` (`KNOWLEDGE_TAGS` and `TAG_DEFINITIONS`; keep the two in step). Six tags follow the pillars of the Passo framework, five name channels, the rest carry context.

| Group | Tags |
|---|---|
| Pillars | `strategy`, `kpis_metrics`, `data_tech`, `governance`, `creative`, `validation` |
| Channels | `meta`, `google`, `pinterest`, `tiktok`, `other_channels` |
| Context | `shopify`, `subscription`, `merchant_profile`, `category_knowledge`, `competitive_intel`, `platform_changes`, `regulation`, `ai_in_marketing` |

No route filters by tag today. Changing the set means rerunning `scripts/reclassify.ts --force`.

## Reclassifying stored documents

`scripts/reclassify.ts` rewrites summary, key insights and tags for every document not yet on the current `PASSO_CONTEXT_VERSION`. Chunks and embeddings are untouched. It is resumable and runs four Haiku calls at a time.

```
node --env-file=.env.local --experimental-strip-types --no-warnings scripts/reclassify.ts --dry-run
node --env-file=.env.local --experimental-strip-types --no-warnings scripts/reclassify.ts
```

---

## Environment variables

Set in `.env.local` locally, and in Vercel project settings for production. All must be present or the server will fail silently.

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Project URL from Supabase settings. The project is **jordanskennard-bot's Project**, which is not the Passo project: Passo's platform database is a separate project in the same account, and it has no pgvector, no `documents` and no `chunks`. Run a migration from `supabase/migrations/` against this one. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (not anon key) — has full DB access |
| `VOYAGE_API_KEY` | Voyage AI key for embeddings |
| `ANTHROPIC_API_KEY` | Anthropic key — used by Haiku (ingest) and Sonnet (ask) |
| `INBOUND_EMAIL_SECRET` | Shared secret for webhook auth — passed as `?key=` in the Postmark inbound webhook URL |
| `NEXT_PUBLIC_INBOUND_EMAIL` | Display email shown in UI (`pantani@passoagency.com`) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (Google Cloud Console) |
| `YOUTUBE_CHANNEL_IDS` | Comma-separated channels for `/api/poll-youtube` |
| `YOUTUBE_LOOKBACK_DAYS` | How far back the poll route looks for new videos (default `7`) |
| `SUPADATA_API_KEY` | Supadata API key for YouTube transcript fetching (bypasses Vercel/AWS IP blocks) |
| `PANTANI_SERVICE_KEY` | Shared secret for the service routes `/api/recommend` and `/api/ideas` — sent as `Authorization: Bearer`. Unset means both answer 503, which is the off switch for both features in the health check. |
| `PANTANI_IDEAS_WINDOW_DAYS` | How far back `/api/ideas` looks for recent knowledge (default `120`). Anything other than a positive whole number falls back to the default. |

---

## Key decisions and why

**Voyage AI via direct fetch, not SDK** — the `voyageai` npm SDK has a broken ESM bundle in Next.js (`Module not found: Can't resolve '../Client'`). Direct fetch to `https://api.voyageai.com/v1/embeddings` works fine.

**Anthropic SDK initialised lazily** — `new Anthropic()` must be called inside a function, not at module level. Module-level initialisation runs before Next.js injects env vars, causing authentication failures.

**`unpdf` not `pdf-parse`** — pdf-parse v2 changed to a class-based API that breaks in the Next.js server context. `unpdf` is a drop-in replacement that works.

**`serverExternalPackages: ['@anthropic-ai/sdk']`** in `next.config.ts` — prevents Webpack from bundling the Anthropic SDK, which breaks its Node.js-native internals.

**Sequential file processing** — the UI queues multiple files and processes them one at a time. This avoids parallel Voyage AI calls hitting the 3 RPM free-tier rate limit.

**Contextual retrieval** — each chunk is embedded as `context_prefix + chunk_text`, not just the raw chunk. This significantly improves retrieval accuracy for long documents where individual chunks lack context. The raw chunk is stored separately so agents receive clean text.

**Inbound email via Postmark** — Postmark provides a dedicated inbound address (`hash@inbound.postmarkapp.com`). Any email forwarded to that address is parsed and POSTed as JSON to `/api/ingest/email`. No MX record setup required — you just forward to Postmark's existing address. The webhook secret is passed as `?key=` in the URL.

**Ask uses hybrid search** — the Ask route (`/api/ask`) combines two retrieval passes: (1) vector similarity search for the top 15 semantically relevant chunks, and (2) keyword search on document titles and summaries for any words in the question longer than 3 characters. This ensures named entities (companies, platforms, products) are never missed due to semantic distance. Results are merged, vector hits first.

**Ask uses Sonnet and supplements the knowledge base** — after retrieval, everything goes to Claude Sonnet with document-level key_insights alongside the chunk passages. Sonnet leads with knowledge base content and fills gaps with its own training knowledge, labelling the source so Jordan can tell curated knowledge from general industry knowledge.

**YouTube transcript via Supadata** — Vercel runs in AWS datacenters; YouTube blocks transcript requests from those IPs. Supadata proxies the request transparently. Free tier is 100 credits/month — sufficient for ongoing polls but bulk channel imports of 100+ videos need a paid plan.

**YouTube dedup by `source_ref`** — YouTube videos are checked against `documents.source_ref` (the watch URL) before fetching any transcript. Cheaper than the MD5 hash check and avoids unnecessary Supadata API calls on re-polls.
