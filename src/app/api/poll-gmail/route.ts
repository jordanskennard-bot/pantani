import { NextResponse } from 'next/server'
import { google } from 'googleapis'
import { ingest } from '@/lib/ingest'
import { extractUrl } from '@/lib/extract'

export const runtime = 'nodejs'

const INGEST_LABEL = 'Pantani'
const DONE_LABEL = 'Pantani-done'

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
  )
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN })
  return auth
}

// Ensure a label exists, creating it if necessary. Returns label id.
async function ensureLabel(gmail: ReturnType<typeof google.gmail>, name: string): Promise<string> {
  const { data } = await gmail.users.labels.list({ userId: 'me' })
  const existing = data.labels?.find((l) => l.name === name)
  if (existing?.id) return existing.id

  const { data: created } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  })
  return created.id!
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
  return [...new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, '')))]
}

export async function GET() {
  const clientId = process.env.GMAIL_CLIENT_ID
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN
  if (!clientId || !refreshToken) {
    return NextResponse.json({ error: 'Gmail not configured — see /scripts/gmail-auth.mjs' }, { status: 503 })
  }

  const auth = getAuth()
  const gmail = google.gmail({ version: 'v1', auth })

  // Ensure both labels exist
  const [ingestLabelId, doneLabelId] = await Promise.all([
    ensureLabel(gmail, INGEST_LABEL),
    ensureLabel(gmail, DONE_LABEL),
  ])

  // Find all messages with the Pantani label but not Pantani-done
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [ingestLabelId],
    q: `-label:${DONE_LABEL}`,
    maxResults: 20,
  })

  const messages = data.messages ?? []
  if (messages.length === 0) {
    return NextResponse.json({ processed: 0 })
  }

  const results = await Promise.allSettled(
    messages.map(async (msg) => {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'full',
      })

      const headers = full.payload?.headers ?? []
      const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)'
      const from = headers.find((h) => h.name === 'From')?.value ?? ''

      // Extract body — walk parts to find text/plain then text/html
      function getPart(payload: typeof full.payload, mimeType: string): string {
        if (!payload) return ''
        if (payload.mimeType === mimeType && payload.body?.data) {
          return Buffer.from(payload.body.data, 'base64').toString('utf-8')
        }
        for (const part of payload.parts ?? []) {
          const found = getPart(part, mimeType)
          if (found) return found
        }
        return ''
      }

      let text = getPart(full.payload, 'text/plain').trim()
      if (!text) {
        const html = getPart(full.payload, 'text/html')
        if (html) {
          const { load } = await import('cheerio')
          const $ = load(html)
          $('style, script').remove()
          text = $('body').text().replace(/\s+/g, ' ').trim()
        }
      }

      if (!text) return { id: msg.id, skipped: true }

      const fullText = `Subject: ${subject}\n\n${text}`

      // Ingest the email
      await ingest({
        sourceType: 'email',
        sourceRef: subject,
        sourceFrom: from,
        title: subject,
        text: fullText,
        metadata: { from, subject, gmailMessageId: msg.id },
      })

      // Ingest URLs found in the body
      const urls = extractUrls(text)
      await Promise.allSettled(
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

      // Move to Pantani-done
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id!,
        requestBody: {
          addLabelIds: [doneLabelId],
          removeLabelIds: [ingestLabelId],
        },
      })

      return { id: msg.id, subject, urlsFound: urls.length }
    })
  )

  const processed = results.filter((r) => r.status === 'fulfilled').length
  const details = results.map((r) => r.status === 'fulfilled' ? r.value : { error: (r as PromiseRejectedResult).reason?.message })

  return NextResponse.json({ processed, details })
}
