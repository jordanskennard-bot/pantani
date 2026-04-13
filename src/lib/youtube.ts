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

function pickTrack(tracks: CaptionTrack[]): CaptionTrack {
  return (
    tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ??
    tracks.find(t => t.languageCode === 'en') ??
    tracks.find(t => t.kind === 'asr') ??
    tracks[0]
  )
}

async function downloadCaptionTrack(track: CaptionTrack): Promise<string> {
  const res = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Caption download failed: ${res.status}`)
  const data = await res.json() as { events: Array<{ segs?: Array<{ utf8: string }> }> }
  return eventsToText(data.events)
}

// Use the InnerTube /player endpoint — returns structured JSON including caption URLs.
// More reliable than page scraping since it's YouTube's own app API.
async function fetchTracksViaPlayerApi(videoId: string, clientName: string, clientVersion: string): Promise<CaptionTrack[]> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName, clientVersion, hl: 'en', gl: 'US' } },
      videoId,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json() as any
  return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
}

async function fetchTranscript(videoId: string): Promise<string> {
  // Try multiple InnerTube clients — each mimics a different YouTube app.
  // TV and Android clients are least likely to be blocked from server IPs.
  const clients: [string, string][] = [
    ['TVHTML5', '7.20240101.16.00'],
    ['ANDROID', '19.09.37'],
    ['WEB', '2.20240313.05.00'],
  ]

  for (const [clientName, clientVersion] of clients) {
    const tracks = await fetchTracksViaPlayerApi(videoId, clientName, clientVersion)
    if (tracks.length) {
      return downloadCaptionTrack(pickTrack(tracks))
    }
  }

  throw new Error('No caption tracks returned by any InnerTube client — video may not have a transcript')
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
