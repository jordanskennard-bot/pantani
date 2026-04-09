const CHUNK_SIZE = 800      // characters
const CHUNK_OVERLAP = 150   // characters of overlap between chunks

// Split text into overlapping chunks, trying to break at sentence or paragraph
// boundaries rather than mid-word.
export function chunkText(text: string): string[] {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (cleaned.length <= CHUNK_SIZE) return [cleaned]

  const chunks: string[] = []
  let start = 0

  while (start < cleaned.length) {
    let end = start + CHUNK_SIZE

    if (end >= cleaned.length) {
      chunks.push(cleaned.slice(start).trim())
      break
    }

    // Try to find a good break point: paragraph > sentence > space
    const slice = cleaned.slice(start, end)
    const paraBreak = slice.lastIndexOf('\n\n')
    const sentenceBreak = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
    )
    const spaceBreak = slice.lastIndexOf(' ')

    let breakAt: number
    if (paraBreak > CHUNK_SIZE * 0.5) {
      breakAt = paraBreak
    } else if (sentenceBreak > CHUNK_SIZE * 0.5) {
      breakAt = sentenceBreak + 1
    } else if (spaceBreak > 0) {
      breakAt = spaceBreak
    } else {
      breakAt = CHUNK_SIZE
    }

    chunks.push(cleaned.slice(start, start + breakAt).trim())
    start = start + breakAt - CHUNK_OVERLAP
  }

  return chunks.filter((c) => c.length > 0)
}
