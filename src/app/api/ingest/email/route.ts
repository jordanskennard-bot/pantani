import { NextRequest, NextResponse } from 'next/server'
import { ingest } from '@/lib/ingest'
import { extractUrl } from '@/lib/extract'

// Extract all http/https URLs from a block of text
function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
  // Deduplicate and strip trailing punctuation
  return [...new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, '')))]
}

export const runtime = 'nodejs'

// This endpoint receives inbound email webhooks.
// Compatible with Resend (inbound), Postmark, and Cloudflare Email Workers.
// Set the webhook secret in INBOUND_EMAIL_SECRET and pass it as a Bearer token
// or as the X-Webhook-Secret header from your email provider.

export async function POST(request: NextRequest) {
  // Verify the webhook secret to prevent unauthorised ingestion.
  // Accepts the secret as a Bearer token, X-Webhook-Secret header,
  // or ?key= query parameter (needed for providers like Resend that
  // don't support custom request headers on inbound webhooks).
  const secret = process.env.INBOUND_EMAIL_SECRET
  if (secret) {
    const authHeader = request.headers.get('authorization') ?? ''
    const secretHeader = request.headers.get('x-webhook-secret') ?? ''
    const queryKey = new URL(request.url).searchParams.get('key') ?? ''
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : secretHeader || queryKey

    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Normalise across Resend / Postmark / generic webhook formats
  const from: string =
    body.from ?? body.From ?? body.sender ?? ''
  const subject: string =
    body.subject ?? body.Subject ?? '(no subject)'
  const textBody: string =
    body.text ?? body.TextBody ?? body.plain ?? body.body ?? ''
  const htmlBody: string =
    body.html ?? body.HtmlBody ?? body.html_body ?? ''

  // Prefer plain text; fall back to stripping HTML tags
  let text = textBody.trim()
  if (!text && htmlBody) {
    const { load } = await import('cheerio')
    const $ = load(htmlBody)
    $('style, script').remove()
    text = $('body').text().replace(/\s+/g, ' ').trim()
  }

  if (!text) {
    return NextResponse.json({ error: 'No text content found in email' }, { status: 422 })
  }

  // Prepend subject so it's part of the searchable content
  const fullText = `Subject: ${subject}\n\n${text}`

  try {
    // Ingest the email itself
    const emailResult = await ingest({
      sourceType: 'email',
      sourceRef: subject,
      sourceFrom: from,
      title: subject,
      text: fullText,
      metadata: { from, subject },
    })

    // Ingest any URLs found in the email body, in parallel
    const urls = extractUrls(text)
    const urlResults = await Promise.allSettled(
      urls.map(async (url) => {
        const { title, text: urlText } = await extractUrl(url)
        return ingest({
          sourceType: 'url',
          sourceRef: url,
          title,
          text: urlText,
          metadata: { domain: new URL(url).hostname, ingestedViaEmail: subject },
        })
      })
    )

    const ingestedUrls = urlResults
      .map((r, i) => ({ url: urls[i], ok: r.status === 'fulfilled' }))

    return NextResponse.json({
      success: true,
      email: emailResult,
      links: ingestedUrls,
    })
  } catch (err) {
    console.error('Email ingest error:', err)
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 })
  }
}
