import * as cheerio from 'cheerio'

// Extract plain text from a PDF buffer
export async function extractPdf(buffer: Buffer): Promise<string> {
  const { extractText } = await import('unpdf')
  const { text } = await extractText(new Uint8Array(buffer))
  return Array.isArray(text) ? text.join('\n') : text
}

// Extract plain text from a .docx buffer
export async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

// Scrape readable text from a URL
export async function extractUrl(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; Pantani-KnowledgeBot/1.0; +https://passo.io)',
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
  }

  const contentType = res.headers.get('content-type') ?? ''

  if (contentType.includes('application/pdf')) {
    const buffer = Buffer.from(await res.arrayBuffer())
    const text = await extractPdf(buffer)
    return { title: url, text }
  }

  const html = await res.text()
  const $ = cheerio.load(html)

  const title = $('title').text().trim() || $('h1').first().text().trim() || url

  // Remove boilerplate elements
  $('script, style, nav, header, footer, aside, .cookie-banner, .ad, [role="banner"]').remove()

  // Prefer article/main content if available
  const content =
    $('article').text() ||
    $('main').text() ||
    $('[role="main"]').text() ||
    $('body').text()

  const text = content
    .replace(/\s+/g, ' ')
    .trim()

  return { title, text }
}

// Extract text from a plain text or markdown file
export function extractPlainText(buffer: Buffer): string {
  return buffer.toString('utf-8')
}
