import { google } from 'googleapis'
import { supabase } from './supabase'
import { ingest } from './ingest'

function getYouTube() {
  return google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY })
}

type ResolvedChannel = { channelId: string; channelTitle: string; uploadsPlaylistId: string }

// Accept a full YouTube channel URL, @handle, or bare channel ID.
// Fetches snippet + contentDetails in one API call so we have both the title
// and uploads playlist ID without a second round-trip.
export async function resolveChannel(input: string): Promise<ResolvedChannel> {
  const yt = getYouTube()
  let normalised = input.trim()

  // Extract from URL
  const handleMatch = normalised.match(/youtube\.com\/@([\w-]+)/)
  if (handleMatch) normalised = `@${handleMatch[1]}`
  const idMatch = normalised.match(/youtube\.com\/channel\/(UC[\w-]+)/)
  if (idMatch) normalised = idMatch[1]

  const parts = ['id', 'snippet', 'contentDetails']

  // Try as @handle or bare handle word
  if (!normalised.startsWith('UC')) {
    const handle = normalised.startsWith('@') ? normalised.slice(1) : normalised
    const { data } = await yt.channels.list({ forHandle: handle, part: parts })
    const ch = data.items?.[0]
    if (ch?.id && ch.contentDetails?.relatedPlaylists?.uploads) {
      return {
        channelId: ch.id,
        channelTitle: ch.snippet?.title ?? handle,
        uploadsPlaylistId: ch.contentDetails.relatedPlaylists.uploads,
      }
    }
  }

  // Try as raw channel ID
  const { data } = await yt.channels.list({ id: [normalised], part: parts })
  const ch = data.items?.[0]
  if (ch?.id && ch.contentDetails?.relatedPlaylists?.uploads) {
    return {
      channelId: ch.id,
      channelTitle: ch.snippet?.title ?? normalised,
      uploadsPlaylistId: ch.contentDetails.relatedPlaylists.uploads,
    }
  }

  throw new Error(`Could not resolve YouTube channel: ${input}`)
}

export type VideoInfo = {
  videoId: string
  title: string
  publishedAt: string
}

// List videos from a channel's uploads playlist (newest first).
// If publishedAfter is set, stops paginating once videos are older than that date.
export async function getChannelVideos(uploadsPlaylistId: string, publishedAfter?: Date): Promise<VideoInfo[]> {
  const yt = getYouTube()
  const uploadsId = uploadsPlaylistId

  const videos: VideoInfo[] = []
  let pageToken: string | undefined

  do {
    const { data } = await yt.playlistItems.list({
      playlistId: uploadsId,
      part: ['snippet', 'contentDetails'],
      maxResults: 50,
      pageToken,
    })

    for (const item of data.items ?? []) {
      const videoId = item.contentDetails?.videoId
      const title = item.snippet?.title
      const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt
      if (!videoId || !title || !publishedAt) continue

      // Uploads playlist is newest-first — once we cross the cutoff we can stop
      if (publishedAfter && new Date(publishedAt) < publishedAfter) return videos

      videos.push({ videoId, title, publishedAt })
    }

    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)

  return videos
}

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

async function isVideoIngested(videoId: string): Promise<boolean> {
  const { data } = await supabase
    .from('documents')
    .select('id')
    .eq('source_ref', videoUrl(videoId))
    .maybeSingle()
  return !!data
}

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string }

function extractCaptionTracks(html: string): CaptionTrack[] {
  // Use bracket-depth tracking instead of regex — YouTube's JSON contains nested
  // objects and \u0026-encoded characters that break simple regex approaches.
  const marker = '"captionTracks":'
  const markerIdx = html.indexOf(marker)
  if (markerIdx === -1) return []

  const startIdx = html.indexOf('[', markerIdx)
  if (startIdx === -1) return []

  let depth = 0
  for (let i = startIdx; i < html.length; i++) {
    if (html[i] === '[') depth++
    else if (html[i] === ']') {
      depth--
      if (depth === 0) {
        try {
          // Unescape Unicode escapes YouTube uses in the embedded JSON
          const jsonStr = html.slice(startIdx, i + 1)
            .replace(/\\u0026/g, '&')
            .replace(/\\u003d/g, '=')
          return JSON.parse(jsonStr)
        } catch {
          return []
        }
      }
    }
  }
  return []
}

function eventsToText(events: Array<{ segs?: Array<{ utf8: string }> }>): string {
  return events
    .filter(e => e.segs)
    .flatMap(e => e.segs!)
    .map(s => s.utf8)
    .filter(t => t !== '\n')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchTranscriptInnerTube(videoId: string): Promise<string> {
  // YouTube's InnerTube API — used by the YouTube app, works reliably from server IPs.
  // Params: protobuf field 1 (string) = videoId, base64-encoded.
  const idBytes = Buffer.from(videoId, 'utf-8')
  const params = Buffer.concat([Buffer.from([0x0a, idBytes.length]), idBytes]).toString('base64')

  const res = await fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      context: {
        client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion: '2.20240313.05.00' },
      },
      params,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) throw new Error(`InnerTube API: ${res.status}`)

  const data = await res.json() as Record<string, unknown>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cueGroups: any[] = (data as any)
    ?.actions?.[0]
    ?.updateEngagementPanelAction
    ?.content
    ?.transcriptRenderer
    ?.body
    ?.transcriptBodyRenderer
    ?.cueGroups

  if (!Array.isArray(cueGroups) || cueGroups.length === 0) {
    throw new Error('No transcript in InnerTube response')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return cueGroups
    .flatMap((g: any) => g?.transcriptCueGroupRenderer?.cues ?? [])
    .map((c: any) => c?.transcriptCueRenderer?.cue?.simpleText ?? '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchTranscript(videoId: string): Promise<string> {
  // 1. Try InnerTube API (most reliable from server IPs)
  try {
    const text = await fetchTranscriptInnerTube(videoId)
    if (text) return text
  } catch {
    // fall through
  }

  // 2. Fall back to page scraping with robust JSON extraction
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!pageRes.ok) throw new Error(`YouTube page fetch failed: ${pageRes.status}`)

  const html = await pageRes.text()
  const tracks = extractCaptionTracks(html)
  if (!tracks.length) throw new Error('No captions found — video may not have a transcript')

  const track =
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ??
    tracks.find(t => t.languageCode === 'en') ??
    tracks.find(t => t.kind === 'asr') ??
    tracks[0]

  const captionRes = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(15_000) })
  if (!captionRes.ok) throw new Error(`Caption download failed: ${captionRes.status}`)

  const data = await captionRes.json() as { events: Array<{ segs?: Array<{ utf8: string }> }> }
  return eventsToText(data.events)
}

export type IngestVideoResult = {
  videoId: string
  title: string
  status: 'ingested' | 'skipped' | 'no_transcript' | 'error'
  error?: string
}

export async function ingestVideo(
  videoId: string,
  title: string,
  channelTitle: string,
): Promise<IngestVideoResult> {
  if (await isVideoIngested(videoId)) {
    return { videoId, title, status: 'skipped' }
  }

  let transcript: string
  try {
    transcript = await fetchTranscript(videoId)
  } catch (err) {
    return { videoId, title, status: 'no_transcript', error: err instanceof Error ? err.message : String(err) }
  }

  if (!transcript.trim()) {
    return { videoId, title, status: 'no_transcript' }
  }

  try {
    await ingest({
      sourceType: 'youtube',
      sourceRef: videoUrl(videoId),
      title,
      text: `Channel: ${channelTitle}\nTitle: ${title}\n\n${transcript}`,
      metadata: { channelTitle, videoId },
    })
    return { videoId, title, status: 'ingested' }
  } catch (err) {
    return {
      videoId,
      title,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
