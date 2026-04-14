const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const EMBEDDING_MODEL = 'voyage-3-lite'
const EMBEDDING_DIM = 512

type VoyageResponse = {
  data: { embedding: number[]; index: number }[]
}

async function callVoyage(
  texts: string[],
  inputType: 'document' | 'query',
  attempt = 1,
): Promise<number[][]> {
  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, input_type: inputType }),
  })

  // On 429 rate-limit, wait and retry up to 3 times
  if (res.status === 429 && attempt <= 3) {
    const wait = attempt * 30_000 // 30s, 60s, 90s
    console.log(`Voyage AI rate limit hit — retrying in ${wait / 1000}s (attempt ${attempt}/3)`)
    await new Promise((r) => setTimeout(r, wait))
    return callVoyage(texts, inputType, attempt + 1)
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Voyage AI error ${res.status}: ${err}`)
  }

  const json = (await res.json()) as VoyageResponse
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

// Embed a batch of texts. Voyage AI supports up to 128 texts per request.
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  return callVoyage(texts, 'document')
}

// Embed a single query (uses query input_type for better retrieval accuracy)
export async function embedQuery(text: string): Promise<number[]> {
  const results = await callVoyage([text], 'query')
  return results[0]
}

export { EMBEDDING_DIM }
