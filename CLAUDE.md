@AGENTS.md

# Pantani — Libro di corsa

Pantani is the knowledge layer of **Passo**, an autonomous programmatic media agency for Shopify DTC merchants in the UK. The name comes from Marco Pantani; "libro di corsa" is Italian for race book — the knowledge base agents consult when making decisions.

Pantani is a RAG (Retrieval Augmented Generation) knowledge store. You feed it documents, emails, and URLs. It classifies, chunks, and embeds them. Agents like **Galibier** (strategy) and **Tourmalet** (narrative) query it to inform media decisions.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js App Router, Node.js runtime |
| Database | Supabase (Postgres + pgvector) |
| Embeddings | Voyage AI `voyage-3-lite` (1024 dimensions) — direct fetch, no SDK |
| Comprehension | Anthropic Claude `claude-haiku-4-5-20251001` — via `@anthropic-ai/sdk` |
| PDF extraction | `unpdf` (not pdf-parse — broken in Next.js) |
| DOCX extraction | `mammoth` |
| HTML scraping | `cheerio` |
| Deployment | Vercel — live at `pantani.passo.ad` |

---

## Ingestion pipeline

Every piece of knowledge follows the same path through `src/lib/ingest.ts`:

1. **Duplicate check** — MD5 hash of raw text, checked against `documents.content_hash`. Returns immediately if already stored. No API calls wasted.
2. **Classify** — one Claude Haiku call: produces a 2-3 sentence summary and tags from the fixed vocabulary.
3. **Store document** — inserts into `documents` table with summary, tags, content_hash, raw_text.
4. **Chunk** — splits text into ~500-token overlapping chunks (`src/lib/chunk.ts`).
5. **Contextualise** — one Claude Haiku call for the whole document: generates a one-sentence context prefix per chunk situating it within the document (Anthropic contextual retrieval technique).
6. **Embed** — Voyage AI embeds `context_prefix + chunk` text. Batched at 64 with 20s delay between batches (free tier is 3 RPM).
7. **Store chunks** — inserts into `chunks` table with content, context_prefix, and embedding vector.

---

## Intake channels

| Channel | Route | How it works |
|---|---|---|
| File drop | `POST /api/ingest/file` | PDF, DOCX, TXT, MD up to 20MB. Multiple files queue sequentially in the UI. |
| URL | `POST /api/ingest/url` | Fetches page, strips boilerplate with cheerio, follows redirects. Also handles PDF URLs. |
| Email | `POST /api/ingest/email` | Webhook from Resend/Postmark. Ingests email body + follows all http/https links found in it. |
| Gmail poll | `GET /api/poll-gmail` | Polls Gmail for emails labelled "Pantani", ingests them, moves to "Pantani-done". |
| YouTube channel | `POST /api/ingest/youtube-channel` | Bulk-ingests all video transcripts from a channel. Body: `{ "channel": "@handle or URL" }`. Processes sequentially. Skips videos with no captions or already ingested (by `source_ref`). |
| YouTube poll | `GET /api/poll-youtube` | Ingests new videos published within `YOUTUBE_LOOKBACK_DAYS` (default 7) from all channels in `YOUTUBE_CHANNEL_IDS`. Intended for Vercel cron. |

---

## Database schema

**`documents`** — one row per ingested item
- `id`, `created_at`, `source_type` (email/file/url/youtube), `source_ref`, `source_from`, `title`
- `raw_text` — full extracted text
- `token_count` — rough estimate (chars / 4)
- `summary` — Claude's 2-3 sentence classification
- `tags` — text[] from fixed vocabulary (GIN indexed)
- `content_hash` — md5(raw_text), unique constraint prevents duplicates
- `metadata` — jsonb for file size, mime type, domain etc.

**`chunks`** — many rows per document
- `document_id` → documents(id) on delete cascade
- `chunk_index`, `content` — raw chunk text
- `context_prefix` — Claude's situating sentence for this chunk
- `embedding` — vector(1024), IVFFlat indexed for cosine similarity search

**`search_knowledge()`** — RPC function for vector search, supports filtering by `source_type` and `tags[]`.

---

## Tag vocabulary

Fixed set — do not change without updating `src/lib/comprehend.ts` and telling agents:

`competitive_intel`, `programmatic`, `cpm_benchmarks`, `attribution`, `audience`, `merchant_profile`, `category_knowledge`, `platform_intel`, `regulation`

---

## Environment variables

Set in `.env.local` locally, and in Vercel project settings for production. All five must be present or the server will fail silently.

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Project URL from Supabase settings |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (not anon key) — has full DB access |
| `VOYAGE_API_KEY` | Voyage AI key for embeddings |
| `ANTHROPIC_API_KEY` | Anthropic key for Claude Haiku |
| `INBOUND_EMAIL_SECRET` | Shared secret for webhook auth on `/api/ingest/email` |
| `NEXT_PUBLIC_INBOUND_EMAIL` | Display email shown in UI (e.g. `pantani@passo.ad`) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (Google Cloud Console) |
| `YOUTUBE_CHANNEL_IDS` | Comma-separated channels for `/api/poll-youtube` (handles, URLs, or UCxxx IDs) |
| `YOUTUBE_LOOKBACK_DAYS` | How far back the poll route looks for new videos (default `7`) |

---

## Key decisions and why

**Voyage AI via direct fetch, not SDK** — the `voyageai` npm SDK has a broken ESM bundle in Next.js (`Module not found: Can't resolve '../Client'`). Direct fetch to `https://api.voyageai.com/v1/embeddings` works fine.

**Anthropic SDK initialised lazily** — `new Anthropic()` must be called inside a function, not at module level. Module-level initialisation runs before Next.js injects env vars, causing authentication failures.

**`unpdf` not `pdf-parse`** — pdf-parse v2 changed to a class-based API that breaks in the Next.js server context. `unpdf` is a drop-in replacement that works.

**`serverExternalPackages: ['@anthropic-ai/sdk']`** in `next.config.ts` — prevents Webpack from bundling the Anthropic SDK, which breaks its Node.js-native internals.

**Sequential file processing** — the UI queues multiple files and processes them one at a time. This avoids parallel Voyage AI calls hitting the 3 RPM free-tier rate limit.

**Contextual retrieval** — each chunk is embedded as `context_prefix + chunk_text`, not just the raw chunk. This significantly improves retrieval accuracy for long documents where individual chunks lack context. The raw chunk is stored separately so agents receive clean text.

**YouTube channel resolution in one API call** — `resolveChannel` in `src/lib/youtube.ts` fetches `id`, `snippet`, and `contentDetails` in a single `channels.list` call, returning both the channel title and uploads playlist ID together. This avoids the naive pattern of a second call to get the playlist ID.

**YouTube dedup by `source_ref`** — YouTube videos are checked against `documents.source_ref` (the watch URL) before fetching any transcript. This is cheaper than the MD5 content hash check lower in the pipeline and avoids unnecessary YouTube API calls on re-polls.

**`youtube-transcript`** — fetches public captions without a quota-bearing API call. Videos without captions (no auto-generated or manual) return `no_transcript` and are skipped silently.

**Vercel cron for YouTube** — add to `vercel.json`: `{ "crons": [{ "path": "/api/poll-youtube", "schedule": "0 6 * * *" }] }`. The lookback window overlaps generously so occasional missed runs don't lose videos.
