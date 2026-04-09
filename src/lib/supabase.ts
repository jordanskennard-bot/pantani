import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Server-side only — uses service role key, never exposed to the client
export const supabase = createClient(supabaseUrl, supabaseKey)

export type Document = {
  id: string
  created_at: string
  source_type: 'email' | 'file' | 'url'
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
