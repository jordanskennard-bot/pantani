import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Initialised lazily so env vars are read at call time, not module load time.
// Module-level initialisation runs during Next.js build when env vars are absent.
let _client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    _client = createClient(url, key)
  }
  return _client
}

export type Document = {
  id: string
  created_at: string
  source_type: 'email' | 'file' | 'url' | 'youtube'
  source_ref: string | null
  source_from: string | null
  title: string | null
  raw_text: string
  token_count: number | null
  metadata: Record<string, unknown>
}

export type Chunk = {
  id: string
  document_id: string
  chunk_index: number
  content: string
  embedding: number[] | null
  created_at: string
}

export type KnowledgeSearchResult = {
  chunk_id: string
  document_id: string
  source_type: string
  source_ref: string | null
  title: string | null
  content: string
  similarity: number
}
